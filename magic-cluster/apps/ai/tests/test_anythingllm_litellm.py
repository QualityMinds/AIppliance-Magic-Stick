import pathlib
import unittest

import yaml


BASE = pathlib.Path(__file__).resolve().parents[1] / 'anything-llm' / 'base'


class AnythingLLMLiteLLMDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.deployment = yaml.safe_load((BASE / 'deployment.yaml').read_text())
        self.pod = self.deployment['spec']['template']['spec']
        self.runtime = self.pod['containers'][0]
        self.bootstrap = next(container for container in self.pod['initContainers']
                              if container['name'] == 'initialize-model-settings')

    def test_native_settings_and_storage_share_the_persistent_volume(self):
        mounts = {mount['mountPath']: mount for mount in self.runtime['volumeMounts']}
        settings = mounts['/app/server/.env']
        self.assertEqual(settings['name'], mounts['/app/server/storage']['name'])
        self.assertEqual(settings['subPath'], 'anythingllm.env')
        volume = next(volume for volume in self.pod['volumes'] if volume['name'] == settings['name'])
        self.assertEqual(volume['persistentVolumeClaim']['claimName'], 'anything-llm-storage')
        self.assertEqual(self.bootstrap['image'], self.runtime['image'])
        self.assertIn('@sha256:', self.runtime['image'])

    def test_runtime_connection_secrets_do_not_override_editable_model_preferences(self):
        self.assertTrue(all('configMapRef' not in source for source in self.runtime['envFrom']))
        variables = {variable['name']: variable for variable in self.runtime['env']}
        self.assertNotIn('LITE_LLM_MODEL_PREF', variables)
        self.assertNotIn('LITE_LLM_MODEL_TOKEN_LIMIT', variables)
        self.assertNotIn('EMBEDDING_MODEL_PREF', variables)
        self.assertEqual(variables['LITE_LLM_API_KEY']['valueFrom']['secretKeyRef'],
                         {'name': 'anything-llm-litellm', 'key': 'LITELLM_API_KEY'})
        for key in ('STORAGE_DIR', 'LITE_LLM_BASE_PATH', 'QDRANT_ENDPOINT'):
            self.assertEqual(variables[key]['valueFrom']['configMapKeyRef']['key'], key)

    def test_bootstrap_reads_catalog_and_writes_storage_before_native_startup(self):
        mounts = {mount['mountPath']: mount for mount in self.bootstrap['volumeMounts']}
        self.assertTrue(mounts['/catalog']['readOnly'])
        self.assertTrue(mounts['/bootstrap']['readOnly'])
        self.assertEqual(mounts['/app/server/storage']['name'], 'anything-llm-storage')
        self.assertEqual(self.bootstrap['command'], ['node', '/bootstrap/model-bootstrap.cjs'])
        self.assertEqual(self.pod['securityContext']['fsGroup'], 1000)
        self.assertEqual(self.deployment['spec']['template']['metadata']['annotations']
                         ['ai-appliance.io/model-catalog-consumer'], 'true')


if __name__ == '__main__':
    unittest.main()
