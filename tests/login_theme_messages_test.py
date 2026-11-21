"""One language per login-server page and per mail: the words the product writes for the login server and its mails.

Keycloak (26.7.3) draws each login page and writes each mail in the one locale it chose (the language menu, the
account's saved locale, the locale cookie, the browser's language, else the realm default; the realm offers ko and en).
For that locale it takes the theme's messages_<locale>.properties over Keycloak's own, and a key neither has falls back
to the English files (the theme's, then Keycloak's). So each language is whole only when the theme's Korean and
English files carry the same keys, the English words have no Hangul, and the Korean words have no English beyond names.

Keycloak's own Korean messages lack keys that reach these screens and mails, written out here (Keycloak 26.7.3
theme/base): the language menu button's name (`languages`) on every login page, the title over the page that ends a
change sent by mail (`accountUpdatedTitle`), and the units of a link's lifetime in the mails (Keycloak has no Korean
email messages at all; the Korean reset mail said "5 minutes").

The sign-in page's style sheet draws four lines of its own (login.css `content`); each has its English line for an
English page (`html[lang="en"]`, the language Keycloak writes into the page), and none draws a field label or a button.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOGIN = ROOT / "keycloak" / "themes" / "kin-login" / "login" / "messages"
CSS = ROOT / "keycloak" / "themes" / "kin-login" / "login" / "resources" / "css" / "login.css"
EMAIL = ROOT / "keycloak" / "themes" / "kin-email" / "email" / "messages"
HANGUL = re.compile(r"[가-힣]")
# Names a Korean sentence keeps in Latin letters: the product's name and two words Korean screens write as they are.
NAMES = {"HALO", "PACS", "OTP", "QR"}
# Keycloak's own Korean messages lack these, and the screens or mails reach them (see the module text).
KOREAN_GAPS = {LOGIN: ("languages", "accountUpdatedTitle"), EMAIL: tuple(f"linkExpirationFormatter.timePeriodUnit.{unit}"
                                                    for unit in ("seconds", "minutes", "hours", "days"))}


def properties(path):
    """Keycloak .properties (UTF-8 in these themes): key=value lines."""
    rows = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            rows[key.strip()] = value.strip()
    return rows


def words(value):
    """The words a reader sees: without mail markup, without the places Keycloak fills ({0}, {0,choice,...}), without
    the line breaks written as \\n."""
    value = re.sub(r"<[^>]*>", " ", value)
    value = re.sub(r"\{[^{}]*\}", " ", value)
    return value.replace("\\n", " ")


class OneLanguagePerScreenAndMailTest(unittest.TestCase):
    def test_01_korean_and_english_carry_the_same_keys(self):
        for folder in (LOGIN, EMAIL):
            with self.subTest(theme=folder.parent.parent.name):
                korean, english = properties(folder / "messages_ko.properties"), properties(folder / "messages_en.properties")
                self.assertEqual(sorted(set(korean) - set(english)), [], "Korean words with no English")
                self.assertEqual(sorted(set(english) - set(korean)), [], "English words with no Korean")

    def test_02_english_words_have_no_hangul(self):
        for folder in (LOGIN, EMAIL):
            for key, value in properties(folder / "messages_en.properties").items():
                with self.subTest(theme=folder.parent.parent.name, key=key):
                    self.assertIsNone(HANGUL.search(value), value)

    def test_03_korean_words_have_no_english_beyond_names(self):
        for folder in (LOGIN, EMAIL):
            for key, value in properties(folder / "messages_ko.properties").items():
                with self.subTest(theme=folder.parent.parent.name, key=key):
                    self.assertTrue(HANGUL.search(value), value)
                    self.assertEqual(set(re.findall(r"[A-Za-z]+", words(value))) - NAMES, set(), value)

    def test_04_keycloak_korean_gaps_are_filled_in_both_languages(self):
        for folder, keys in KOREAN_GAPS.items():
            korean, english = properties(folder / "messages_ko.properties"), properties(folder / "messages_en.properties")
            for key in keys:
                with self.subTest(theme=folder.parent.parent.name, key=key):
                    self.assertTrue(HANGUL.search(korean.get(key, "")), key)
                    self.assertTrue(re.search(r"[A-Za-z]", english.get(key, "")), key)

    def test_05_mails_keep_their_link_and_lifetime_in_both_languages(self):
        """Each mail of each language puts the link and the lifetime in the places Keycloak fills, as the Korean did."""
        places = {"emailVerificationBody": ("{0}", "{2}", "{3}"), "emailVerificationBodyHtml": ('href="{0}"', "{2}", "{3}"),
                  "passwordResetBody": ("{0}", "{2}", "{3}"), "passwordResetBodyHtml": ('href="{0}"', "{2}", "{3}"),
                  "executeActionsBody": ("{0}", "{2}", "{3}", "{4}"), "executeActionsBodyHtml": ('href="{0}"', "{2}", "{3}", "{4}")}
        for language in ("ko", "en"):
            rows = properties(EMAIL / f"messages_{language}.properties")
            for key, wanted in places.items():
                with self.subTest(language=language, key=key):
                    for place in wanted:
                        self.assertIn(place, rows[key])
            for key in ("emailVerificationSubject", "passwordResetSubject", "executeActionsSubject"):
                with self.subTest(language=language, key=key):
                    self.assertTrue(rows[key].startswith("[HALO PACS] "), rows[key])

    def test_06_no_lone_quote_that_keycloak_would_drop(self):
        """Keycloak formats every message with Java's MessageFormat, where a single ' starts a quoted run and is not
        shown; a quote mark to be shown is written ''."""
        for folder in (LOGIN, EMAIL):
            for language in ("ko", "en"):
                for key, value in properties(folder / f"messages_{language}.properties").items():
                    with self.subTest(theme=folder.parent.parent.name, language=language, key=key):
                        self.assertNotRegex(value.replace("''", ""), "'", value)

    def test_07_the_unsuffixed_file_is_the_korean_one(self):
        """messages.properties (no locale; Keycloak 26.7.3 reads only messages_<locale>) stays the Korean file's copy."""
        self.assertEqual(properties(LOGIN / "messages.properties"), properties(LOGIN / "messages_ko.properties"))


def render(template, *args):
    """Java MessageFormat as Keycloak uses it, for these files: {n} and {n,choice,a#x|b<y} places, '' for a quote."""
    def place(match):
        index, _, choice = match.group(1).partition(",choice,")
        value = args[int(index)]
        if not choice:
            return str(value)
        picked = None
        for option in choice.split("|"):
            bound, mark, text = re.match(r"(\d+)([#<])(.*)", option).groups()
            if value > int(bound) if mark == "<" else value >= int(bound):
                picked = text
        return picked
    return re.sub(r"\{([^{}]+)\}", place, template).replace("''", "'").replace("\\n", "\n")


def lifetime(rows, minutes):
    """Keycloak's link-lifetime words (LinkExpirationFormatterMethod): "<number> <unit>", the unit from the mail's messages."""
    unit, value = ("hours", minutes // 60) if minutes % 60 == 0 and minutes >= 60 else ("minutes", minutes)
    return f"{value} {render(rows['linkExpirationFormatter.timePeriodUnit.' + unit], value)}"


class MailsAsKeycloakWritesThemTest(unittest.TestCase):
    """Each mail rendered as Keycloak fills it (the reset mail: link, minutes, realm name, lifetime; the administrator's
    request: link, minutes, realm name, the actions in the mail's language, lifetime) reads in one language."""

    LINK = "https://syn.test/auth/realms/kin/login-actions/action-token?key=syn"

    def mails(self, language):
        rows = properties(EMAIL / f"messages_{language}.properties")
        actions = ", ".join(rows[f"requiredAction.{name}"] for name in ("UPDATE_PASSWORD", "CONFIGURE_TOTP"))
        out = {}
        for minutes in (1, 5, 720):
            gone = lifetime(rows, minutes)
            for key in ("passwordResetBody", "passwordResetBodyHtml", "emailVerificationBody", "emailVerificationBodyHtml"):
                out[(key, minutes)] = render(rows[key], self.LINK, minutes, "HALO PACS", gone)
            for key in ("executeActionsBody", "executeActionsBodyHtml"):
                out[(key, minutes)] = render(rows[key], self.LINK, minutes, "HALO PACS", actions, gone)
        for key in ("emailVerificationBodyCode", "emailVerificationBodyCodeHtml"):
            out[(key, 0)] = render(rows[key], "123456")
        for key in ("passwordResetSubject", "executeActionsSubject", "emailVerificationSubject",
                    "emailTestSubject", "emailTestBody", "emailTestBodyHtml"):
            out[(key, 0)] = render(rows[key])
        return out

    def test_01_korean_mails_read_in_korean(self):
        for (key, minutes), text in self.mails("ko").items():
            with self.subTest(key=key, minutes=minutes):
                seen = re.sub(r"<[^>]*>", " ", text).replace(self.LINK, " ")
                self.assertEqual(set(re.findall(r"[A-Za-z]+", seen)) - NAMES, set(), text)
        mails = self.mails("ko")
        self.assertIn("5 분 동안 유효합니다", mails[("passwordResetBody", 5)])
        self.assertIn("12 시간 동안 유효합니다", mails[("executeActionsBody", 720)])
        self.assertIn("비밀번호 변경, OTP 설정", mails[("executeActionsBody", 5)])

    def test_02_english_mails_read_in_english(self):
        for (key, minutes), text in self.mails("en").items():
            with self.subTest(key=key, minutes=minutes):
                self.assertIsNone(HANGUL.search(text), text)
        mails = self.mails("en")
        self.assertIn("valid for 5 minutes.", mails[("passwordResetBody", 5)])
        self.assertIn("valid for 1 minute.", mails[("passwordResetBody", 1)])
        self.assertIn("valid for 12 hours.", mails[("executeActionsBody", 720)])
        self.assertIn("Change password, Set up OTP", mails[("executeActionsBody", 5)])

    def test_03_the_link_and_code_stay_where_keycloak_puts_them(self):
        for language in ("ko", "en"):
            mails = self.mails(language)
            with self.subTest(language=language):
                self.assertIn(self.LINK, mails[("passwordResetBody", 5)])
                self.assertIn(f'<a href="{self.LINK}">', mails[("passwordResetBodyHtml", 5)])
                self.assertIn(f'<a href="{self.LINK}">', mails[("executeActionsBodyHtml", 5)])
                self.assertIn("<b>123456</b>", mails[("emailVerificationBodyCodeHtml", 0)])


def css_rules(text):
    """(selector, content) of each rule of login.css that draws words (a quoted content that is not empty)."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return [(selector.strip(), words) for selector, body in re.findall(r"([^{}]+)\{([^{}]*)\}", text)
            for words in re.findall(r'content:\s*"((?:[^"\\]|\\.)+)"', body)]


class SignInPageSheetWordsTest(unittest.TestCase):
    def test_01_each_korean_line_of_the_sheet_has_its_english_line(self):
        rules = css_rules(CSS.read_text(encoding="utf-8"))
        korean = {selector: words for selector, words in rules if HANGUL.search(words)}
        english = {selector[len('html[lang="en"] '):]: words for selector, words in rules
                   if selector.startswith('html[lang="en"] ')}
        self.assertEqual(sorted(korean), sorted(english), "a Korean line with no English one, or the other way")
        self.assertEqual(len(korean), 4, korean)
        for selector, words in english.items():
            with self.subTest(selector=selector):
                self.assertIsNone(HANGUL.search(words), words)
                self.assertTrue(re.search(r"[A-Za-z]{3}", words), words)

    def test_02_no_label_or_button_words_drawn_by_the_sheet(self):
        """The field labels and the sign-in button show Keycloak's own words (the messages above), so no line of the
        sheet stands in for them in one language only."""
        for selector, words in css_rules(CSS.read_text(encoding="utf-8")):
            with self.subTest(selector=selector):
                self.assertNotRegex(selector, r"label|kc-form-buttons|kc-login", words)


if __name__ == "__main__":
    unittest.main()
