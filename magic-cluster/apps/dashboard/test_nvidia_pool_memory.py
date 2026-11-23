import copy
import unittest

from test_dashboard_api import load_server


class NvidiaPoolMemoryTests(unittest.TestCase):
    def setUp(self):
        self.api = load_server()
        self.models = []
        self.nodes = [{"metadata": {"name": "fixture-node", "uid": "fixture-node-uid", "labels": {"gpu": "ready"}}}]
        self.cards = [{"id": "gpu-" + str(i), "kind": "gpu", "computeTarget": "nvidia-gpu",
                       "nodes": ["fixture-node"], "totalMi": 49140, "unreservedMi": 49140} for i in range(4)]
        self.api.update({
            "model_activations": lambda: self.models,
            "ready_schedulable_nodes": lambda: self.nodes,
            "compute_target_catalog": lambda: {"targets": {"nvidia-gpu": {"kind": "gpu", "nodeSelector": {"gpu": "ready"}}}},
            "vram_summary": lambda _: {"available": True, "plannedRemainingMi": 4 * 49140},
            "compute_memory_summary": self.memory,
            "estimate_vllm_memory": lambda *_: {"weightsMi": 150000, "kvCacheMi": 5000, "runtimeReserveMi": 3500},
            "estimate_ollama_memory": lambda *_: {"weightsMi": 150000, "kvCacheMi": 5000, "runtimeReserveMi": 3500},
            "offloading_host_memory_available": lambda *_: 240000,
        })

    def memory(self, activations, _vram=None):
        return {"devices": self.api["assign_gpu_reservations"](copy.deepcopy(self.cards),
                self.api["active_model_memory_reservations"](activations))}

    def local(self, engine="VLLM", budget=40000):
        return {"engine": engine, "computeTarget": "nvidia-gpu", "modelType": "chat", "vramMi": budget,
                "url": "hf://example/model" if engine == "VLLM" else "ollama://example:small"}

    def test_automatic_estimate_is_one_card_not_the_four_card_sum(self):
        for engine in ("VLLM", "OLlama"):
            with self.subTest(engine=engine):
                result = self.api["estimate_model_memory"](self.local(engine))
                self.assertEqual(result["maximumMi"], 49140)
                self.assertEqual(result["physicalMaximumMi"], 49140)
                self.assertEqual(result["memoryBudgetScope"], "per-device")
                self.assertGreater(result["minimumMi"], result["maximumMi"])

    def test_automatic_pool_cannot_guarantee_the_larger_of_unequal_cards(self):
        self.cards[1]["totalMi"] = 24576
        result = self.api["estimate_model_memory"](self.local())
        self.assertEqual(result["physicalMaximumMi"], 24576)
        self.assertEqual(result["maximumMi"], 24576)

    def test_unknown_card_capacity_never_falls_back_to_aggregate_vram(self):
        self.cards[1]["totalMi"] = 0
        result = self.api["estimate_model_memory"](self.local())
        self.assertIsNone(result["maximumMi"])
        self.assertIsNone(result["physicalMaximumMi"])

    def test_foreign_or_ineligible_nodes_do_not_supply_capacity(self):
        self.cards.append({**self.cards[0], "nodes": ["foreign"], "totalMi": 12000})
        self.nodes.append({"metadata": {"name": "ineligible", "labels": {"gpu": "not-ready"}}})
        self.cards.append({**self.cards[0], "nodes": ["ineligible"], "totalMi": 8000})
        self.assertEqual(self.api["estimate_model_memory"](self.local())["maximumMi"], 49140)

    def test_edit_estimate_excludes_only_its_own_reservation_without_adding_its_invalid_budget(self):
        self.models = [{"metadata": {"name": "existing-model"}, "spec": {"type": "local", "enabled": True,
                       "local": self.local(budget=182300)}}]
        self.api["editable_model_activation"] = lambda _: self.models[0]
        result = self.api["estimate_model_update"]("existing-model", {"contextWindow": 4096})
        self.assertEqual(result["maximumMi"], 49140)
        self.assertEqual(result["physicalMaximumMi"], 49140)
        self.models.extend({"metadata": {"name": "other-" + str(i)}, "spec": {"type": "local", "enabled": True,
                            "local": self.local(budget=40000)}} for i in range(4))
        result = self.api["estimate_model_update"]("existing-model", {"contextWindow": 4096})
        self.assertEqual(result["maximumMi"], 9140)  # Other reservations stay charged.
        self.assertEqual(result["physicalMaximumMi"], 49140)

    def test_create_and_edit_reject_physically_impossible_budgets_even_with_risk_acceptance(self):
        for engine in ("VLLM", "OLlama"):
            for exclude in ("", "existing-model"):
                for risk in (False, True):
                    with self.subTest(engine=engine, exclude=exclude, risk=risk):
                        local = {**self.local(engine, 182300), "allowMemoryRisk": risk}
                        with self.assertRaisesRegex(ValueError, "physical.*single|single.*physical"):
                            self.api["model_activation_payload"]("local", {"name": "fixture-model", "local": local}, exclude)

    def test_legal_underestimated_or_oversubscribed_budget_remains_an_explicit_risk(self):
        self.models = [{"metadata": {"name": "other-" + str(i)}, "spec": {"type": "local", "local": self.local(budget=40000)}} for i in range(4)]
        for engine in ("VLLM", "OLlama"):
            local = {**self.local(engine, 49000), "allowMemoryRisk": True}
            self.assertLess(self.api["estimate_model_memory"](local)["maximumMi"], local["vramMi"])
            saved = self.api["model_activation_payload"]("local", {"name": "fixture-model", "local": local})
            self.assertEqual(saved["spec"]["local"]["vramMi"], 49000)
