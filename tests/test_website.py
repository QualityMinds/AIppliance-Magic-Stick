# SPDX-License-Identifier: BUSL-1.1
"""Static landing-page contracts; interaction/layout checks also need a browser."""
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import unittest

import yaml

from tools import docs


class Markup(HTMLParser):
    def __init__(self, content):
        super().__init__()
        self.elements = []
        self.feed(content)

    def handle_starttag(self, tag, attrs):
        self.elements.append((tag, dict(attrs)))

    def matching(self, tag=None, **attrs):
        return [a for t, a in self.elements
                if (tag is None or t == tag) and all(a.get(k) == v for k, v in attrs.items())]


class WebsiteTests(unittest.TestCase):
    pages = {
        'index.html': ('en', '', 'de.html'),
        'de.html': ('de', 'de.html', ''),
        'editions.html': ('en', 'editions.html', 'editionen.html'),
        'editionen.html': ('de', 'editionen.html', 'editions.html'),
    }
    public = 'https://qualityminds.github.io/AIppliance-Magic-Stick/'

    def markup(self, name):
        return Markup((docs.DOCS / name).read_text())

    def test_pages_are_published_excluded_from_handbook_and_not_legacy_redirects(self):
        config = yaml.safe_load((docs.ROOT / 'mkdocs.yml').read_text())
        excluded = config['exclude_docs'].splitlines()
        aliases = {str(Path(name).with_suffix('.html')) for name in
                   json.loads((docs.DOCS / 'migration.json').read_text())}
        for name in self.pages:
            with self.subTest(page=name):
                self.assertIn(name, docs.MARKETING_PAGES)
                self.assertIn('/' + name, excluded)
                self.assertNotIn(name, aliases)

    def test_unique_ids_single_main_and_heading(self):
        for name in self.pages:
            with self.subTest(page=name):
                page = self.markup(name)
                ids = [a['id'] for _, a in page.elements if 'id' in a]
                self.assertEqual(len(ids), len(set(ids)))
                self.assertEqual(len(page.matching('main')), 1)
                self.assertEqual(len(page.matching('h1')), 1)
                self.assertEqual(len(page.matching('title')), 1)
                self.assertTrue(page.matching('a', href='#main'))
                for _, attrs in page.elements:
                    for attribute in ('aria-controls', 'aria-labelledby'):
                        for target in attrs.get(attribute, '').split():
                            self.assertIn(target, ids)

    def test_language_canonical_and_social_metadata(self):
        for name, (language, path, alternate) in self.pages.items():
            with self.subTest(page=name):
                page = self.markup(name)
                self.assertEqual(page.matching('html')[0]['lang'], language)
                self.assertEqual(page.matching('link', rel='canonical')[0]['href'], self.public + path)
                self.assertTrue(page.matching('link', rel='alternate', hreflang=language,
                                              href=self.public + path))
                other = 'de' if language == 'en' else 'en'
                self.assertTrue(page.matching('link', rel='alternate', hreflang=other,
                                              href=self.public + alternate))
                self.assertTrue(page.matching('link', rel='alternate', hreflang='x-default'))
                self.assertTrue(page.matching('a', lang=language, **{'aria-current': 'page'}))
                self.assertTrue(page.matching('a', lang=other, href=alternate or 'index.html'))
                self.assertGreater(len(page.matching('meta', name='description')[0]['content']), 80)
                self.assertTrue(page.matching('meta', property='og:url', content=self.public + path))
                self.assertTrue(page.matching('meta', name='twitter:card', content='summary_large_image'))
                image_url = page.matching('meta', property='og:image')[0]['content']
                self.assertTrue(image_url.startswith(self.public))
                self.assertTrue((docs.DOCS / image_url.removeprefix(self.public)).is_file())

    def test_no_external_runtime_or_tracking_dependency(self):
        for name in self.pages:
            with self.subTest(page=name):
                page = self.markup(name)
                self.assertEqual(page.matching('script'), [{'src': 'site.js', 'defer': None}])
                self.assertEqual(page.matching('link', rel='stylesheet'),
                                 [{'rel': 'stylesheet', 'href': 'site.css'}])
                self.assertFalse(page.matching('iframe'))
                self.assertFalse(page.matching('form'))
                self.assertTrue(page.matching('link', rel='icon', href='assets/favicon.svg'))
        script = (docs.DOCS / 'site.js').read_text()
        self.assertNotRegex(script, r'\b(fetch|XMLHttpRequest|localStorage|sessionStorage)\b|document\.cookie')
        css = (docs.DOCS / 'site.css').read_text()
        self.assertIn('prefers-reduced-motion', css)
        self.assertIn('[hidden] { display: none !important; }', css)

    def test_tabs_and_navigation_are_progressively_enhanced(self):
        for name in ('index.html', 'de.html'):
            with self.subTest(page=name):
                page = self.markup(name)
                controls = page.matching(role='tablist')
                self.assertEqual(len(controls), 1)
                self.assertIn('hidden', controls[0])
                tabs = page.matching(role='tab')
                panels = page.matching(role='tabpanel')
                self.assertEqual(len(tabs), 3)
                self.assertEqual(len(panels), 3)
                self.assertEqual(sum(t['aria-selected'] == 'true' for t in tabs), 1)
                self.assertEqual({t['aria-controls'] for t in tabs}, {p['id'] for p in panels})
                self.assertTrue(all('hidden' not in p for p in panels))
                menu = page.matching('button', **{'class': 'menu-toggle'})[0]
                self.assertIn('hidden', menu)
                self.assertEqual(menu['aria-expanded'], 'false')
                navigation = page.matching('nav', id='main-navigation')[0]
                self.assertNotIn('hidden', navigation)
                self.assertNotIn('data-collapsed', navigation)

    def test_images_use_reviewed_unchanged_sources_and_full_size_links(self):
        manifest = json.loads((docs.DOCS / 'assets/screenshots/captures.json').read_text())
        images = {i['file']: i for i in manifest['images']}
        for name in ('index.html', 'de.html'):
            with self.subTest(page=name):
                page = self.markup(name)
                self.assertEqual(len(page.matching('img')), 5)
                for img in page.matching('img'):
                    source = img['src']
                    self.assertTrue(source.startswith('assets/screenshots/'))
                    record = images[Path(source).name]
                    self.assertEqual(int(img['width']), record['width'])
                    self.assertEqual(int(img['height']), record['height'])
                    self.assertGreater(len(img['alt']), 35)
                    self.assertTrue(page.matching('a', href=source))
                hero = page.matching('img', fetchpriority='high')
                self.assertEqual(len(hero), 1)
                self.assertNotIn('loading', hero[0])
                self.assertEqual(len(page.matching('img', loading='lazy')), 4)

    def test_existing_landing_anchors_are_preserved_in_both_languages(self):
        anchors = {'main-navigation', 'main', 'top', 'hero-title', 'produkt',
                   'product-title', 'anwendungen', 'apps-title', 'tab-knowledge',
                   'tab-code', 'tab-api', 'panel-knowledge', 'panel-code', 'panel-api',
                   'operate-title', 'lizenzen', 'open-title', 'starten', 'start-title',
                   'faq-title'}
        for name in ('index.html', 'de.html'):
            self.assertTrue(anchors.issubset({a['id'] for _, a in self.markup(name).elements if 'id' in a}))

    def test_architecture_explains_both_paths_and_local_runtime(self):
        for name in ('index.html', 'de.html'):
            with self.subTest(page=name):
                page = self.markup(name)
                self.assertEqual(len(page.matching('section', id='architecture')), 1)
                self.assertEqual(len([attrs for tag, attrs in page.elements
                                      if tag == 'div' and 'architecture-flow' in attrs.get('class', '').split()]), 2)
                self.assertEqual(len(page.matching('div', **{'class': 'architecture-runtime'})), 1)
                self.assertTrue(page.matching('a', href='concepts/architecture.md'))
                text = (docs.DOCS / name).read_text()
                for component in ('Dashboard', 'Magic Stick Operator', 'LiteLLM',
                                  'Ollama', 'vLLM', 'FreeToken', 'Flux', 'Keycloak'):
                    self.assertIn(component, text)

    def test_source_links_and_markdown_conversion(self):
        files = [docs.DOCS / name for name in self.pages]
        self.assertEqual(docs.check_links(files, docs.ROOT), [])
        for path in files:
            page = self.markup(path.name)
            for a in page.matching('a'):
                href = a.get('href', '')
                self.assertNotEqual(href, '#')
                self.assertFalse(href.startswith('/'), href)
                self.assertFalse(href.startswith('../'), href)
            rendered = docs.marketing_links(path.read_text())
            self.assertIn('href="handbook/"', rendered)
            self.assertNotRegex(rendered, r'href="(?!https?://)[^"]+\.md(?:#.*?)?"')

    def test_license_pages_point_to_authoritative_terms_and_real_request_flow(self):
        for name in ('editions.html', 'editionen.html'):
            text = (docs.DOCS / name).read_text()
            page = self.markup(name)
            self.assertIn('BSL 1.1', text)
            self.assertIn('Free Registered', text)
            self.assertIn('Commercial', text)
            self.assertIn('System → License → Request license', text)
            for target in ('LICENSE', 'LICENSING.md', 'THIRD_PARTY_NOTICES.md', 'SUPPORT.md'):
                self.assertTrue(page.matching('a', href=docs.REPO + '/blob/main/' + target))
            self.assertTrue(page.matching('a', href='administration/licenses.md'))
            self.assertTrue(page.matching('a', href='legal-notice.html#provider'))


if __name__ == '__main__':
    unittest.main()
