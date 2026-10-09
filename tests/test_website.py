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
        self.elements, self.text, self.scripts, self.open = [], [], [], None
        self.feed(content)

    def handle_starttag(self, tag, attrs):
        self.elements.append((tag, dict(attrs)))
        self.open = tag

    def handle_endtag(self, tag):
        self.open = None

    def handle_data(self, data):
        if self.open == 'script':
            self.scripts.append(data)
        elif self.open != 'style':
            self.text.append(data)

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
    # English legal page -> German twin. Both must change together (see
    # test_legal_pages_stay_in_sync_across_languages).
    legal_pairs = {'imprint.html': 'impressum.html', 'privacy.html': 'datenschutz.html'}
    # Link targets that differ only by language are compared as their English form.
    language_pairs = {**legal_pairs, 'de.html': 'index.html', 'editionen.html': 'editions.html',
                      'https://www.microsoft.com/de-de/': 'https://www.microsoft.com/en-us/'}
    public = 'https://magic-stick.ai/'

    @property
    def legal(self):
        pages = {}
        for english, german in self.legal_pairs.items():
            pages[english] = ('en', german)
            pages[german] = ('de', english)
        return pages

    def markup(self, name):
        return Markup((docs.DOCS / name).read_text())

    def test_pages_are_published_excluded_from_handbook_and_not_legacy_redirects(self):
        config = yaml.safe_load((docs.ROOT / 'mkdocs.yml').read_text())
        excluded = config['exclude_docs'].splitlines()
        aliases = {str(Path(name).with_suffix('.html')) for name in
                   json.loads((docs.DOCS / 'migration.json').read_text())}
        for name in (*self.pages, *self.legal):
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
        # The only remote script, the cookie-free Umami tag, is added by the build
        # from mkdocs.yml (docs.analytics_tag); the sources never carry it.
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
                screenshots = [img for img in page.matching('img') if img['src'].startswith('assets/screenshots/')]
                self.assertEqual(len(screenshots), 3)
                for img in screenshots:
                    source = img['src']
                    record = images[Path(source).name]
                    self.assertEqual(int(img['width']), record['width'])
                    self.assertEqual(int(img['height']), record['height'])
                    self.assertGreater(len(img['alt']), 35)
                    self.assertEqual(img['loading'], 'lazy')
                    self.assertTrue(page.matching('a', href=source))
                # Brand marks and the hero artwork are decorative: empty alt text,
                # declared dimensions and a reviewed asset folder.
                for img in page.matching('img'):
                    if img in screenshots:
                        continue
                    self.assertEqual(img.get('alt'), '')
                    self.assertTrue(img['src'].startswith(('assets/brand/', 'assets/artwork/')), img['src'])
                    self.assertTrue((docs.DOCS / img['src']).is_file())
                    self.assertTrue(img.get('width') and img.get('height'))
                hero = page.matching('img', fetchpriority='high')
                self.assertEqual(len(hero), 1)
                self.assertNotIn('loading', hero[0])
                self.assertEqual(hero[0]['src'], 'assets/artwork/command-centre.jpg')
                # Only the hero artwork is eager; the heading image is a plain <img> (no lazy attribute).
                eager = [img for img in page.matching('img') if 'loading' not in img and img is not hero[0]]
                self.assertTrue(all(img['src'] == 'assets/brand/logo.svg' or img['src'] == 'assets/brand/brandmark.svg' for img in eager))

    def test_existing_landing_anchors_are_preserved_in_both_languages(self):
        # Fragments linked from other pages (editions, handbook, footer) stay stable.
        anchors = {'main-navigation', 'main', 'top', 'hero-title', 'produkt', 'product-title',
                   'anwendungen', 'apps-title', 'requirements', 'requirements-title', 'hardware',
                   'starten', 'start-title', 'teams', 'teams-title', 'lizenzen', 'faq', 'faq-title'}
        for name in ('index.html', 'de.html'):
            self.assertTrue(anchors.issubset({a['id'] for _, a in self.markup(name).elements if 'id' in a}))

    def test_landing_pages_name_components_and_link_technical_detail(self):
        """The landing page stays non-technical; the FAQ names the components and links the architecture."""
        for name in ('index.html', 'de.html'):
            with self.subTest(page=name):
                page = self.markup(name)
                self.assertTrue(page.matching('a', href='concepts/architecture.md'))
                self.assertTrue(page.matching('a', href='reference/compatibility.md'))
                self.assertTrue(page.matching('a', href='get-started/requirements.md'))
                for route in ('bare-metal', 'cloud-init-vm', 'existing-vm', 'existing-kubernetes'):
                    self.assertTrue(page.matching('a', href=f'installation/{route}.md'), route)
                self.assertGreaterEqual(len(page.matching('details')), 6)
                text = (docs.DOCS / name).read_text()
                for component in ('Magic Stick Operator', 'LiteLLM', 'KubeAI', 'Ollama', 'vLLM',
                                  'Flux', 'Keycloak', 'Envoy'):
                    self.assertIn(component, text)
                self.assertNotIn('FreeToken', text)
                # The only published contact address is the provider address of the imprint.
                for a in page.matching('a'):
                    if a.get('href', '').startswith('mailto:'):
                        self.assertEqual(a['href'], 'mailto:info@magic-stick.ai')

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
            notice = 'imprint.html' if name == 'editions.html' else 'impressum.html'
            self.assertTrue(page.matching('a', href=notice + '#provider'))

    def test_legal_pages_are_linked_and_privacy_matches_statistics_setup(self):
        config = yaml.safe_load((docs.ROOT / 'mkdocs.yml').read_text())
        override = docs.ROOT / config['theme']['custom_dir'] / 'partials/copyright.html'
        footer = override.read_text()
        # The handbook is English only: its footer links the English legal pages
        # with the same labels as the English landing page.
        for target, label in (('imprint.html', 'Imprint'), ('privacy.html', 'Privacy')):
            self.assertIn(f"{{{{ base_url.rstrip('/') }}}}/../{target}\">{label}</a>", footer)
        for german in self.legal_pairs.values():
            self.assertNotIn(german, footer)
        # Landing pages link the legal pages of their own language.
        for name, (language, _, _) in self.pages.items():
            page = self.markup(name)
            for english, german in self.legal_pairs.items():
                with self.subTest(page=name, target=english):
                    self.assertTrue(page.matching('a', href=english if language == 'en' else german))
        tag = docs.analytics_tag(config)
        self.assertIn('data-exclude-search="true"', tag)
        self.assertIn('data-exclude-hash="true"', tag)
        # The retention job deletes after the period the policy states, and the
        # Umami version the policy describes is pinned.
        template = (docs.ROOT / 'infrastructure/landingpage/umami.bicep').read_text()
        months = re.search(r'^param retentionMonths int = (\d+)$', template, re.M)[1]
        self.assertIn("resource purge 'Microsoft.App/jobs@", template)
        self.assertRegex(template, r"(?m)^param image string = '[^']+@sha256:[0-9a-f]{64}'$")
        # The policy names the Azure regions of the Umami app and its database.
        regions = {'germanywestcentral': 'Germany West Central', 'westeurope': 'West Europe'}
        parameters = (docs.ROOT / 'infrastructure/landingpage/umami.bicepparam').read_text()
        phrases = {
            'privacy.html': ('without query string or fragment', f'deleted {months} months after collection'),
            'datenschutz.html': ('ohne Query-String und Fragment', f'{months} Monate nach der Erhebung gelöscht'),
        }
        for name, expected in phrases.items():
            with self.subTest(page=name):
                privacy = re.sub(r'\s+', ' ', (docs.DOCS / name).read_text())
                for phrase in expected:
                    self.assertIn(phrase, privacy)
                self.assertIn("'umami.disabled'", privacy)
                self.assertIn('Do Not Track', privacy)
                self.assertTrue(Markup(privacy).matching(id='opt-out'))
                for parameter in ('location', 'databaseLocation'):
                    region = re.search(rf"^param {parameter} = '([a-z]+)'", parameters, re.M)[1]
                    self.assertIn(regions[region], privacy)

    def test_legal_pages_have_language_metadata_and_switch(self):
        for name, (language, twin) in self.legal.items():
            with self.subTest(page=name):
                page = self.markup(name)
                other = 'de' if language == 'en' else 'en'
                english = name if language == 'en' else twin
                self.assertEqual(page.matching('html')[0]['lang'], language)
                self.assertEqual(page.matching('link', rel='canonical')[0]['href'], self.public + name)
                self.assertTrue(page.matching('link', rel='alternate', hreflang=language, href=self.public + name))
                self.assertTrue(page.matching('link', rel='alternate', hreflang=other, href=self.public + twin))
                self.assertTrue(page.matching('link', rel='alternate', hreflang='x-default', href=self.public + english))
                self.assertTrue(page.matching('a', lang=language, href=name, **{'aria-current': 'page'}))
                self.assertTrue(page.matching('a', lang=other, href=twin))
                self.assertTrue(page.matching('a', href='index.html' if language == 'en' else 'de.html'))
                self.assertGreater(len(page.matching('meta', name='description')[0]['content']), 80)
                self.assertTrue(page.matching('meta', name='robots', content='index,follow'))
                for tag in ('title', 'h1', 'main', 'footer', 'time'):
                    self.assertEqual(len(page.matching(tag)), 1, tag)
                ids = [a['id'] for _, a in page.elements if 'id' in a]
                self.assertEqual(len(ids), len(set(ids)))
                for _, attrs in page.elements:
                    for target in attrs.get('aria-labelledby', '').split():
                        self.assertIn(target, ids)
                # Self-contained: inline styles and at most the inline opt-out script.
                self.assertFalse([a for _, a in page.elements if 'src' in a])
                self.assertFalse(page.matching('link', rel='stylesheet'))
                self.assertFalse(page.matching('iframe') or page.matching('form'))

    def test_legal_pages_stay_in_sync_across_languages(self):
        """The German and English versions are one legal text in two languages.

        A change to one page must be mirrored in the other: same sections and
        anchors, same element structure, same link targets, same numbers (legal
        references, addresses, retention periods), same inline script and the
        same "last updated" date.
        """
        def normalise(href):
            for german, english in self.language_pairs.items():
                if href.startswith(german):
                    return english + href[len(german):]
            return href

        def outline(name):
            page = self.markup(name)
            body = page.elements[[tag for tag, _ in page.elements].index('body'):]
            return {
                'structure': [tag for tag, _ in body],
                'ids': [attrs['id'] for _, attrs in body if 'id' in attrs],
                'links': [normalise(attrs['href']) for tag, attrs in body if tag == 'a'],
                'updated': page.matching('time')[0]['datetime'],
                'numbers': sorted(re.findall(r'\d+', ''.join(page.text))),
                'script': [re.sub(r"'[^']*'", "''", s) for s in page.scripts],
            }

        for english, german in self.legal_pairs.items():
            with self.subTest(pages=(english, german)):
                left, right = outline(english), outline(german)
                for key in left:
                    self.assertEqual(left[key], right[key], f'{key} differs between {english} and {german}')
                self.assertRegex(left['updated'], r'^\d{4}-\d{2}-\d{2}$')


if __name__ == '__main__':
    unittest.main()
