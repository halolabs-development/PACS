"""CI browser setup preserves package verification and unrelated sources."""
import importlib.util
from pathlib import Path
import os,unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('browser_apt',Path(__file__).resolve().parents[1]/'scripts/ci_browser_apt.py')
apt=importlib.util.module_from_spec(spec);spec.loader.exec_module(apt)

class BrowserAptTests(unittest.TestCase):
 def test_list_filters_only_active_exact_google_chrome_repositories(self):
  text='deb [arch=amd64 signed-by=/key.gpg] https://dl.google.com/linux/chrome-stable/deb/ stable main\n'
  other='deb https://archive.ubuntu.com/ubuntu noble main\n# deb https://dl.google.com/linux/chrome/deb stable main\ndeb https://dl.google.com.evil.invalid/linux/chrome/deb stable main\n'
  changed=apt.without_chrome(text+other,'.list')
  self.assertEqual(changed,'# Disabled for pinned Playwright CI: '+text+other)
  self.assertEqual(apt.without_chrome(changed,'.list'),changed)
 def test_deb822_preserves_ubuntu_and_signed_by(self):
  ubuntu='Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble\nComponents: main\nSigned-By: /ubuntu.gpg\n'
  google='Types: deb\nURIs: https://dl.google.com/linux/chrome-stable/deb/\nSuites: stable\nComponents: main\nSigned-By: /google.gpg\nEnabled: yes\n'
  changed=apt.without_chrome(ubuntu+'\n'+google,'.sources')
  self.assertEqual(changed,ubuntu+'\n'+google.replace('Enabled: yes','Enabled: no'))
  self.assertEqual(apt.without_chrome(changed,'.sources'),changed)
 def test_deb822_multiline_mixed_uri_keeps_other_mirror(self):
  text='Types: deb\nURIs: https://dl.google.com/linux/chrome/deb\n https://example.invalid/mirror\nSuites: stable\nSigned-By: /key.gpg\n'
  self.assertEqual(apt.without_chrome(text,'.sources'),'Types: deb\nURIs: https://example.invalid/mirror\nSuites: stable\nSigned-By: /key.gpg\n')
  single=apt.without_chrome('URIs: https://dl.google.com/linux/chrome/deb\nSuites: stable\n','.sources')
  self.assertIn('Enabled: no',single)
 def test_non_ci_execution_refuses_before_filesystem_changes(self):
  with patch.dict(os.environ,{},clear=True),patch.object(apt.Path,'iterdir',side_effect=AssertionError('must not inspect sources')):
   with self.assertRaises(RuntimeError):apt.main()
 def test_deb_cache_hooks_copy_in_before_update_and_out_after_dpkg(self):
  hooks=apt.deb_cache_hooks('/home/runner/.cache/playwright-apt')
  self.assertIn('APT::Update::Pre-Invoke { "cp /home/runner/.cache/playwright-apt/*.deb /var/cache/apt/archives/ 2>/dev/null || true"; };',hooks)
  self.assertIn('DPkg::Post-Invoke { "cp /var/cache/apt/archives/*.deb /home/runner/.cache/playwright-apt/ 2>/dev/null || true"; };',hooks)
  # No signature or hash option is relaxed.
  self.assertNotRegex(hooks,r'(?i)allow-?unauthenticated|AllowInsecure|trusted|Check-Valid')
 def test_deb_cache_folder_belongs_to_the_invoking_user(self):
  import sys,tempfile,types
  with tempfile.TemporaryDirectory() as home:
   owned=[]
   entry=types.SimpleNamespace(pw_dir=home,pw_uid=1001,pw_gid=127)
   fake=types.SimpleNamespace(getpwnam=lambda user:entry if user=='runner' else None)
   hooks=Path(home)/'hooks.conf'
   with patch.dict(os.environ,{'SUDO_USER':'runner'}),patch.dict(sys.modules,{'pwd':fake}),\
        patch.object(apt.os,'chown',side_effect=lambda path,uid,gid:owned.append((Path(path),uid,gid)),create=True),\
        patch.object(apt,'HOOKS',hooks):
    apt.prepare_deb_cache()
   folder=Path(home)/'.cache/playwright-apt'
   self.assertTrue(folder.is_dir())
   self.assertEqual(owned,[(folder.parent,1001,127),(folder,1001,127)])
   self.assertEqual(hooks.read_text(encoding='utf-8'),apt.deb_cache_hooks(folder))
  with patch.dict(os.environ,{},clear=True),patch.object(apt,'HOOKS',Path('/nonexistent/hooks')):
   apt.prepare_deb_cache()  # not run through sudo: no folder, no hooks
if __name__=='__main__':unittest.main(verbosity=2)
