# SPDX-License-Identifier: BUSL-1.1
"""Check discovery metadata and references without executing skill workflows."""
from pathlib import Path
import tempfile
import unittest

from tools import check_agent_guidance as guidance


class AgentGuidanceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for path in guidance.INSTRUCTIONS:
            self.file(path, '# Project instructions\n')
        self.skill()

    def file(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')
        return path

    def skill(self, folder='example-work', name=None, description='Handle scoped example work.', body='# Work\n'):
        return self.file(
            f'.agents/skills/{folder}/SKILL.md',
            f'---\nname: {name or folder}\ndescription: "{description}"\n---\n\n{body}',
        )

    def test_valid_guidance_and_optional_metadata(self):
        self.skill(body='[guide](../../../docs/guide.md#result)\n')
        self.file('docs/guide.md', '# Result\n')
        self.assertEqual(guidance.check(self.root), [])
        self.file('.agents/skills/example-work/SKILL.md',
                  '---\nname: example-work\ndescription: "Useful workflow"\n'
                  'metadata:\n  short-description: "Example"\n---\n# Work\n')
        self.assertEqual(guidance.check(self.root), [])

    def test_missing_or_empty_instruction_file(self):
        for content in ('', ' \n'):
            with self.subTest(content=content):
                self.file('dashboard/AGENTS.md', content)
                self.assertTrue(any('missing or empty instructions' in e for e in guidance.check(self.root)))
        (self.root / 'dashboard/AGENTS.md').unlink()
        self.assertTrue(any('dashboard/AGENTS.md' in e for e in guidance.check(self.root)))

    def test_missing_skill_entrypoint(self):
        self.file('.agents/skills/incomplete/references/guide.md', '# Guide\n')
        self.assertTrue(any('missing skill entrypoint' in e for e in guidance.check(self.root)))

    def test_no_skills_is_not_a_silent_pass(self):
        (self.root / '.agents/skills/example-work/SKILL.md').unlink()
        (self.root / '.agents/skills/example-work').rmdir()
        self.assertTrue(any('no repository skills' in e for e in guidance.check(self.root)))

    def test_bad_frontmatter(self):
        cases = ('# No metadata\n', '---\nname: unfinished\n', '---\n[not: valid\n---\n# Work',
                 '---\n- item\n---\n# Work', '---\nname: example-work\ndescription: ok\n'
                 'name: second-name\n---\n# Work')
        for content in cases:
            with self.subTest(content=content):
                entry = self.file('.agents/skills/example-work/SKILL.md', content)
                with self.assertRaises(ValueError):
                    guidance.skill_metadata(entry)

    def test_invalid_names_and_descriptions(self):
        for name in ('Mixed-Case', '-bad', 'bad--name', 'x' * 65, '123'):
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    guidance.skill_metadata(self.skill(name=name))
        for description in ('', '   ', 'x' * 1025, '<example>'):
            with self.subTest(description=description):
                with self.assertRaises(ValueError):
                    guidance.skill_metadata(self.skill(description=description))

    def test_missing_fields_and_empty_body(self):
        for content in ('---\nname: example-work\n---\n# Work',
                        '---\ndescription: Useful work\n---\n# Work',
                        '---\nname: example-work\ndescription: 12\n---\n# Work',
                        '---\nname: example-work\ndescription: Useful work\n---\n'):
            with self.subTest(content=content):
                with self.assertRaises(ValueError):
                    guidance.skill_metadata(self.file('.agents/skills/example-work/SKILL.md', content))

    def test_directory_name_and_unique_identity(self):
        self.skill(folder='other-work', name='example-work')
        errors = guidance.check(self.root)
        self.assertTrue(any('name does not match' in e for e in errors))
        self.assertTrue(any('duplicate skill name' in e for e in errors))

    def test_missing_reference_and_anchor_fail(self):
        self.skill(body='[missing](references/missing.md) [anchor](../../../docs/guide.md#absent)')
        self.file('docs/guide.md', '# Present\n')
        errors = guidance.check(self.root)
        self.assertTrue(any('missing target' in e for e in errors))
        self.assertTrue(any('missing anchor' in e for e in errors))

    def test_supporting_reference_links_are_checked(self):
        self.file('.agents/skills/example-work/references/guide.md', '[missing](lost.md)')
        self.assertTrue(any('references/guide.md' in e for e in guidance.check(self.root)))

    def test_external_links_are_not_fetched(self):
        self.skill(body='[upstream](https://example.invalid/guide)\n')
        self.assertEqual(guidance.check(self.root), [])

    def test_legacy_skill_copy_is_rejected(self):
        self.file('.codex/skills/old-work/SKILL.md', '# Old\n')
        self.assertTrue(any('legacy skill copy' in e for e in guidance.check(self.root)))

    def test_additional_valid_skill_needs_no_checker_change(self):
        self.skill(folder='another-work')
        self.assertEqual(guidance.check(self.root), [])

    def test_actual_repository_contract(self):
        self.assertEqual(guidance.check(), [])


if __name__ == '__main__':
    unittest.main()
