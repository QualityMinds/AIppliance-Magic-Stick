# SPDX-License-Identifier: BUSL-1.1
"""Regression checks for the GitHub/website documentation contract."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import yaml

from tools import docs, docs_hook


class DocumentationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def file(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def test_github_duplicates_unicode_and_code_fences(self):
        headings = docs.github_headings('# Start\n## Start\n```md\n## Not a heading\n```\n## Über GPU / RAM\n')
        self.assertEqual(headings, {'start', 'start-1', 'über-gpu--ram'})

    def test_markdown_links_and_explicit_legacy_anchors(self):
        source = self.file('index.md', '[next](guide.md#old-title) ![image](assets/picture.svg)')
        self.file('guide.md', '# New title\n\n<a id="old-title"></a>')
        self.file('assets/picture.svg', '<svg></svg>')
        self.assertEqual(docs.check_links([source], self.root), [])

    def test_missing_target_and_fragment_are_errors(self):
        source = self.file('index.md', '[missing](lost.md) [heading](guide.md#missing)')
        self.file('guide.md', '# Actual heading')
        errors = docs.check_links([source], self.root)
        self.assertEqual(len(errors), 2)
        self.assertTrue(any('missing target' in e for e in errors))
        self.assertTrue(any('missing anchor' in e for e in errors))

    def test_project_prefix_in_generated_404_links(self):
        source = self.file('handbook/404.html', '<a href="/project/handbook/guide/#result">Guide</a>')
        self.file('handbook/guide/index.html', '<h1 id="result">Result</h1>')
        self.assertEqual(docs.check_links([source], self.root, '/project'), [])

    def test_does_not_strip_partial_prefix(self):
        source = self.file('index.html', '<a href="/project-other/">wrong</a>')
        self.assertEqual(len(docs.check_links([source], self.root, '/project')), 1)

    def test_external_and_mail_links_do_not_resolve_as_files(self):
        source = self.file('index.md', '[web](https://example.com) [mail](mailto:example@example.com)')
        self.assertEqual(docs.check_links([source], self.root), [])

    def test_page_routes(self):
        self.assertEqual(docs.page_url('README.md'), 'handbook/')
        self.assertEqual(docs.page_url('installation/README.md'), 'handbook/installation/')
        self.assertEqual(docs.page_url('user-guide/models/manage.md'), 'handbook/user-guide/models/manage/')

    def test_legacy_html_has_fragment_map_and_no_script_injection(self):
        result = docs.redirect_document('handbook/', {'old': 'handbook/new/#current', '</script>': 'safe/'})
        self.assertIn('handbook/new/#current', result)
        self.assertIn('location.replace', result)
        self.assertEqual(result.count('</script>'), 1)
        self.assertIn('Open the current guide', result)

    def test_legacy_routes_check_actual_rendered_ids(self):
        self.file('docs/migration.json', json.dumps({'old.md': {'target': 'new.md', 'anchors': {'old': 'new.md#new-heading'}}}))
        self.file('out/handbook/new/index.html', '<h1 id="new-heading">New</h1>')
        with patch.object(docs, 'DOCS', self.root / 'docs'), patch.object(docs, 'OUT', self.root / 'out'):
            self.assertEqual(docs.check_migration_output(), [])
            self.file('out/handbook/new/index.html', '<h1 id="changed">New</h1>')
            self.assertIn('missing rendered anchor', docs.check_migration_output()[0])

    def test_landing_links_are_rendered_without_changing_external_links(self):
        source = '<a href="installation/bare-metal.md#network">USB</a><a href="https://example.com/a.md">outside</a>'
        rendered = docs.marketing_links(source)
        self.assertIn('href="handbook/installation/bare-metal/#network"', rendered)
        self.assertIn('href="https://example.com/a.md"', rendered)

    def test_link_hook_keeps_markdown_and_rewrites_repository_targets(self):
        source = self.file('docs/guide/topic.md', '')
        self.file('tools/example.py', '# source')
        self.file('docs/site.css', 'body {}')
        self.file('docs/guide/other.md', '# Other')
        original = '[code](../../tools/example.py) [guide](other.md) [style](../site.css)\n```md\n[example](../../tools/example.py)\n```'
        page = SimpleNamespace(file=SimpleNamespace(abs_src_path=str(source)))
        with patch.object(docs_hook, 'ROOT', self.root), patch.object(docs_hook, 'DOCS', self.root / 'docs'):
            result = docs_hook.on_page_markdown(original, page, {'site_url':'https://example.com/project/handbook/'}, None)
        self.assertIn('/blob/main/tools/example.py', result)
        self.assertIn('[guide](other.md)', result)
        self.assertIn('https://example.com/project/site.css', result)
        self.assertIn('```md\n[example](../../tools/example.py)', result)
        self.assertEqual(source.read_text(), '')

    def test_external_check_excludes_local_addresses_and_secrets(self):
        for url in ['http://localhost:8765/', 'http://127.0.0.1/', 'http://10.20.30.40/',
                    'http://192.168.1.5/', 'http://[::1]/', 'https://appliance.local/',
                    'https://service.example.com/', 'http://service/',
                    'https://user:secret@github.com/', 'https://<host>/']:
            with self.subTest(url=url): self.assertFalse(docs.public_url(url))
        self.assertTrue(docs.public_url('https://docs.k3s.io/datastore/backup-restore'))

    def test_navigation_and_top_level_sections(self):
        navigation = json.loads((docs.DOCS / 'navigation.json').read_text())
        sections = [next(iter(item)) for item in navigation]
        self.assertEqual(sections, ['Home', 'Get started', 'Installation', 'User guide',
                                    'Administration', 'Concepts', 'Reference', 'Development'])
        paths = list(docs.nav_paths(navigation))
        self.assertEqual(len(paths), len(set(paths)))
        self.assertTrue(all((docs.DOCS / path).exists() for path in paths))

    def test_catalog_reference_is_current(self):
        self.assertEqual((docs.DOCS / 'reference/compatibility.md').read_text(), docs.compatibility())

    def test_dated_report_is_not_in_current_search(self):
        report = (docs.DOCS / 'development/reports/2026-09-21-freetoken.md').read_text()
        metadata = yaml.safe_load(report.split('---', 2)[1])
        self.assertTrue(metadata['search']['exclude'])

    def test_ci_checks_pull_requests_but_only_deploys_main(self):
        workflow = yaml.safe_load((docs.ROOT / '.github/workflows/docs.yml').read_text())
        events = workflow.get('on', workflow.get(True))
        self.assertIn('pull_request', events)
        self.assertIn('schedule', events)
        self.assertEqual(workflow['permissions'], {'contents': 'read'})
        jobs = workflow['jobs']
        self.assertEqual(jobs['build']['permissions']['pages'], 'read')
        self.assertIn("refs/heads/main", jobs['deploy']['if'])
        self.assertIn("!= 'pull_request'", jobs['deploy']['if'])
        self.assertIn("!= 'schedule'", jobs['deploy']['if'])
        self.assertTrue(jobs['external-links']['continue-on-error'])
        self.assertNotIn('pull_request', jobs['external-links']['if'])

    def test_all_legacy_paths_anchors_and_targets_survive(self):
        records = json.loads((docs.DOCS / 'migration.json').read_text())
        for old, record in records.items():
            with self.subTest(path=old):
                source = docs.DOCS / old
                self.assertTrue(source.is_file())
                self.assertTrue((docs.DOCS / record['target']).is_file())
                ids = docs.parse(source).ids
                for anchor, route in record['anchors'].items():
                    self.assertIn(anchor, ids)
                    target, _, fragment = route.partition('#')
                    self.assertTrue((docs.DOCS / target).is_file())
                    if fragment: self.assertIn(fragment, docs.parse(docs.DOCS / target).ids)


if __name__ == '__main__':
    unittest.main()
