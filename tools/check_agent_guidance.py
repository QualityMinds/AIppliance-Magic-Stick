# SPDX-License-Identifier: BUSL-1.1
"""Read-only checks for repository instruction and skill discovery contracts."""
import argparse
from pathlib import Path
import re

import yaml

if __package__:
    from . import docs
else:
    import docs

ROOT = Path(__file__).resolve().parents[1]
INSTRUCTIONS = ('AGENTS.md', 'dashboard/AGENTS.md', 'docs/AGENTS.md')
NAME = re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*')


class UniqueKeysLoader(yaml.SafeLoader):
    """Reject ambiguous frontmatter instead of silently taking the last value."""


def unique_mapping(loader, node, deep=False):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        try:
            duplicate = key in mapping
        except TypeError as exc:
            raise yaml.constructor.ConstructorError(
                None, None, 'frontmatter keys must be scalar', key_node.start_mark
            ) from exc
        if duplicate:
            raise yaml.constructor.ConstructorError(
                None, None, 'duplicate frontmatter key', key_node.start_mark
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


UniqueKeysLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping
)


def skill_metadata(path):
    """Return valid discovery metadata or a useful validation error."""
    content = path.read_text(encoding='utf-8')
    match = re.match(r'\A---\n(.*?)\n---(?:\n|$)', content, re.S)
    if not match:
        raise ValueError('missing or malformed YAML frontmatter')
    try:
        metadata = yaml.load(match[1], Loader=UniqueKeysLoader)
    except yaml.YAMLError as exc:
        raise ValueError('invalid YAML frontmatter') from exc
    if not isinstance(metadata, dict):
        raise ValueError('frontmatter must be a mapping')
    name = metadata.get('name')
    if not isinstance(name, str) or not NAME.fullmatch(name) or len(name) > 64:
        raise ValueError('name must be 1-64 lowercase letters/digits with single hyphens')
    description = metadata.get('description')
    if not isinstance(description, str) or not description.strip() or len(description) > 1024:
        raise ValueError('description must be a nonempty string of at most 1024 characters')
    if '<' in description or '>' in description:
        raise ValueError('description must not contain angle brackets')
    if not content[match.end():].strip():
        raise ValueError('skill instructions are empty')
    return metadata


def check(root=ROOT):
    """Validate files only; never execute skills or fetch linked URLs."""
    root = Path(root).resolve()
    errors, sources, names = [], [], {}
    for relative in INSTRUCTIONS:
        path = root / relative
        if not path.is_file() or not path.read_text(encoding='utf-8').strip():
            errors.append(f'{relative}: missing or empty instructions')
        else:
            sources.append(path)

    skill_root = root / '.agents/skills'
    folders = sorted(p for p in skill_root.iterdir() if p.is_dir()) if skill_root.is_dir() else []
    if not folders:
        errors.append('.agents/skills: no repository skills found')
    for folder in folders:
        entry = folder / 'SKILL.md'
        label = entry.relative_to(root).as_posix()
        if not entry.is_file():
            errors.append(f'{label}: missing skill entrypoint')
            continue
        sources.extend(folder.rglob('*.md'))
        try:
            metadata = skill_metadata(entry)
        except ValueError as exc:
            errors.append(f'{label}: {exc}')
            continue
        name = metadata['name']
        if name != folder.name:
            errors.append(f'{label}: name does not match skill directory')
        if name in names:
            errors.append(f'{label}: duplicate skill name also in {names[name]}')
        names[name] = label

    for path in sorted((root / '.codex/skills').rglob('SKILL.md')):
        errors.append(f'{path.relative_to(root)}: legacy skill copy; use .agents/skills only')

    errors.extend(docs.check_links(sorted(set(sources)), root))
    return sorted(set(errors))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT, help='repository to inspect')
    args = parser.parse_args()
    errors = check(args.root)
    if errors:
        print('\n'.join(errors))
        return 1
    print('Agent guidance checks passed: instructions, skill metadata, names and local links.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
