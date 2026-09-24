# SPDX-License-Identifier: BUSL-1.1
"""Keep repository links usable in the static handbook without editing Markdown."""
import json
import os
import re
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs'
REPO = 'https://github.com/QualityMinds/AIppliance-Magic-Stick'


def on_config(config):
    config['nav'] = json.loads((DOCS / 'navigation.json').read_text())
    return config


def on_page_markdown(markdown, page, config, files):
    """Repository-relative source links become GitHub links only in HTML output."""
    source = Path(page.file.abs_src_path)

    def replace(match):
        href = match[2]
        if re.match(r'^[a-zA-Z][\w+.-]*:', href) or href.startswith(('#', '//')):
            return match[0]
        path, sep, fragment = href.partition('#')
        target = Path(os.path.normpath(source.parent / unquote(path)))
        try:
            relative = target.relative_to(ROOT)
        except ValueError:
            return match[0]
        if target.is_relative_to(DOCS):
            if target.parent == DOCS and (target.suffix == '.html' or target.name in ('site.css', 'site.js')):
                href = config['site_url'].rstrip('/').rsplit('/', 1)[0] + '/' + target.name + sep + fragment
            else:
                return match[0]
        else:
            kind = 'tree' if target.is_dir() else 'blob'
            href = f'{REPO}/{kind}/main/{relative.as_posix()}' + sep + fragment
        return match[1] + href + match[3]

    # Do not rewrite examples inside code fences.
    sections = re.split(r'(^```[^\n]*\n.*?^```\s*$|^~~~[^\n]*\n.*?^~~~\s*$)', markdown, flags=re.M | re.S)
    return ''.join(part if i % 2 else re.sub(r'(\]\()([^\s)]+)(\))', replace, part)
                   for i, part in enumerate(sections))
