"""Exclude unused Google Chrome APT sources on disposable GitHub-hosted runners.

Playwright downloads its pinned Chromium separately. Its OS dependency installer
runs apt update, which otherwise also queries the runner's unrelated Chrome repo.
APT signature/hash verification and all Ubuntu package sources remain enabled.

The browser's OS packages are reused from the invoking user's DEB_CACHE folder, which the
workflow caches: apt copies them in before its update and out after dpkg. apt reuses a file
whose name and size match the signed index and downloads any other (a newer version or a
truncated file). Only this repository's jobs write that cache, under the same workflow trust.
"""
import os
from pathlib import Path
import re
import shlex
from urllib.parse import urlsplit

SOURCES=Path('/etc/apt/sources.list.d')
HOOKS=Path('/etc/apt/apt.conf.d/99kin-ci-deb-cache')
DEB_CACHE='.cache/playwright-apt'


def chrome_url(value):
    url=urlsplit(value)
    return url.scheme in ('http','https') and url.hostname=='dl.google.com' and bool(re.match(r'^/linux/chrome(?:-stable)?/deb/?$',url.path))


def without_chrome(text,suffix):
    if suffix=='.list':
        return ''.join('# Disabled for pinned Playwright CI: '+line if
            re.match(r'^\s*deb(?:-src)?\s',line) and any(chrome_url(token) for token in line.split()) else line
            for line in text.splitlines(keepends=True))
    if suffix!='.sources':raise ValueError('Unsupported APT source format')
    def stanza(block):
        match=re.search(r'^URIs:[ \t]*(.*(?:\n[ \t]+[^\n]*)*)',block,re.M)
        if not match:return block
        urls=match.group(1).split()
        if not any(chrome_url(url) for url in urls):return block
        kept=[url for url in urls if not chrome_url(url)]
        if kept:return block[:match.start()]+'URIs: '+' '.join(kept)+block[match.end():]
        if re.search(r'^Enabled:',block,re.M):return re.sub(r'^Enabled:.*$', 'Enabled: no',block,flags=re.M)
        return block.rstrip('\n')+'\nEnabled: no\n'
    return '\n\n'.join(stanza(block) for block in text.split('\n\n'))


def deb_cache_hooks(folder):
    q=shlex.quote(str(folder))
    return ('// Reuse cached browser OS packages; apt takes a file whose name and size match the index.\n'
        'APT::Update::Pre-Invoke { "cp '+q+'/*.deb /var/cache/apt/archives/ 2>/dev/null || true"; };\n'
        'DPkg::Post-Invoke { "cp /var/cache/apt/archives/*.deb '+q+'/ 2>/dev/null || true"; };\n')


def prepare_deb_cache():
    user=os.environ.get('SUDO_USER')
    if not user or user=='root':return
    import pwd
    entry=pwd.getpwnam(user)
    folder=Path(entry.pw_dir)/DEB_CACHE
    # Created for the invoking user: the cache restore and save run as that user.
    for path in (folder.parent,folder):
        if not path.exists():
            path.mkdir()
            os.chown(path,entry.pw_uid,entry.pw_gid)
    HOOKS.write_text(deb_cache_hooks(folder),encoding='utf-8')
    print('Browser OS packages are reused from '+str(folder),flush=True)


def main():
    if os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted' or os.geteuid()!=0:
        raise RuntimeError('Only a root process on a disposable GitHub-hosted runner may prepare browser APT sources')
    for path in sorted(SOURCES.iterdir()):
        if path.suffix not in ('.list','.sources'):continue
        if path.is_symlink():raise RuntimeError('Unexpected linked APT source')
        if not path.is_file():continue
        old=path.read_text(encoding='utf-8');new=without_chrome(old,path.suffix)
        if old!=new:
            path.write_text(new,encoding='utf-8')
            print('Excluded unused Chrome APT source in '+path.name,flush=True)
    prepare_deb_cache()


if __name__=='__main__':main()
