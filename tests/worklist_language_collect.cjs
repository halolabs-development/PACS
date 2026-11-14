'use strict';
// The words a screen script writes, read with the TypeScript parser (no text scanning): every string and template
// literal, and every chain of `+` that joins words with values, as one piece whose filled-in parts are numbered markers.
// Each part says what it is: e an error message, n a number, t words the code chose (every value a literal), or data.
// Usage: node worklist_language_collect.cjs <file>... (prints JSON: [{file, line, value, kinds, ui}])
const fs = require('node:fs'), path = require('node:path');
const ts = require(path.join(__dirname, '../api/node_modules/typescript'));

const ERRORS = new Set(['e', 'err', 'error', 'ex', 'failure', 'cause']);
const NUMBERS = new Set(['length', 'size', 'count', 'total', 'images', 'number', 'done', 'failed', 'remaining', 'left', 'pending',
  'index', 'page', 'pages', 'revision', 'version', 'attempt', 'attempts', 'n', 'i', 'k', 'num', 'shown', 'loaded', 'saved', 'sent',
  'selected', 'checked', 'skipped', 'added', 'removed', 'moved', 'width', 'height', 'frames', 'series', 'studies', 'rows', 'seconds', 'minutes', 'percent']);
// Calls and properties through which a literal reaches the screen.
const UI_PROPS = new Set(['textContent', 'innerText', 'innerHTML', 'outerHTML', 'title', 'placeholder', 'label', 'ariaLabel', 'alt']);
const UI_CALLS = new Set(['toast', 'alert', 'confirm', 'prompt', 'setCustomValidity', 'say', 'note', 'show', 'announce', 'tell', 'setStatus',
  'status', 'append', 'prepend', 'replaceChildren', 'insertAdjacentText', 'insertAdjacentHTML', 'createTextNode', 'element', 'el', 'make', 'node',
  'button', 'btn', 'chip', 'h', 'tag', 'create', 'option', 'plain', 'primary', 'cancel', 'labelled', 'add', 'line', 'row', 'cell', 'heading',
  'field', 'section', 'group', 'link', 'item', 'tab', 'action', 'menuItem', 'choice', 'pick', 'toggle', 'fail', 'fill', 'message', 'reason', 'finish']);
const UI_KEYS = new Set(['t', 'label', 'title', 'text', 'name', 'help', 'hint', 'summary', 'caption', 'legend', 'word', 'words', 'placeholder',
  'tip', 'why', 'empty', 'none', 'message', 'msg', 'heading', 'note', 'status', 'reason', 'detail', 'notice', 'absent', 'guidance', 'error']);
const UI_ATTRS = new Set(['title', 'aria-label', 'placeholder', 'alt', 'aria-valuetext', 'aria-description']);

const isText = n => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n);
const unwrap = n => { while (n && ts.isParenthesizedExpression(n)) n = n.expression; return n; };
const isPlus = n => n && ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;
function words(n) {
  n = unwrap(n);
  if (!n) return false;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return true;
  if (ts.isConditionalExpression(n)) return words(n.whenTrue) && words(n.whenFalse);
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return words(n.right);
  return false;
}
function numeric(n) {
  n = unwrap(n);
  if (!n) return false;
  if (ts.isNumericLiteral(n)) return true;
  if (ts.isIdentifier(n)) return NUMBERS.has(n.text);
  if (ts.isPropertyAccessExpression(n)) return NUMBERS.has(n.name.text);
  if (ts.isBinaryExpression(n) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken].includes(n.operatorToken.kind))
    return (ts.isNumericLiteral(unwrap(n.left)) || numeric(n.left)) && (ts.isNumericLiteral(unwrap(n.right)) || numeric(n.right));
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
    const callee = n.expression;
    if (['Math', 'Number'].includes(callee.expression.getText())) return true;
    if (callee.name.text === 'toFixed' || callee.name.text === 'toLocaleString' && n.arguments.length === 0 && numeric(callee.expression)) return true;
  }
  if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Number') return true;
  return false;
}
function kind(n) {
  const u = unwrap(n);
  const error = x => ts.isPropertyAccessExpression(x) && x.name.text === 'message' && ts.isIdentifier(unwrap(x.expression)) && ERRORS.has(unwrap(x.expression).text);
  if (error(u) || ts.isBinaryExpression(u) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(u.operatorToken.kind) && error(unwrap(u.left))) return 'e';
  if (numeric(u)) return 'n';
  if (words(u)) return 't';
  return '';
}
// Where the text goes: up through choices, joins and wrappers to the place that shows it.
// A value of a table of words (an object property) or one of the words a choice gives is a candidate too: whether it
// is a label is then judged by its own form (english_label in worklist_language_collect.py).
function ui(n) {
  for (let child = n, p = n.parent; p; child = p, p = p.parent) {
    if (ts.isConditionalExpression(p) && child !== p.condition) return true;
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind) && child === p.right) return true;
    if (ts.isParenthesizedExpression(p) || ts.isTemplateSpan(p) || ts.isTemplateExpression(p)
      || ts.isBinaryExpression(p) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(p.operatorToken.kind)
      || ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p) || ts.isAsExpression?.(p)) continue;
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken].includes(p.operatorToken.kind) && child === p.right)
      return ts.isPropertyAccessExpression(p.left) && UI_PROPS.has(p.left.name.text);
    if (ts.isPropertyAssignment(p) && child === p.initializer) return true;
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
      if (child === p.expression) return false;
      const callee = p.expression, name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (ts.isNewExpression(p)) return name === 'Option' && p.arguments?.[0] === child;
      if (name === 'setAttribute') return p.arguments.length > 1 && p.arguments[1] === child && ts.isStringLiteral(p.arguments[0]) && UI_ATTRS.has(p.arguments[0].text);
      if (name === 'join') continue;
      return UI_CALLS.has(name);
    }
    return false;
  }
  return false;
}

function collect(file) {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out = [], inChain = new Set();
  const line = n => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
  function piece(parts, at) {
    let value = '';
    const kinds = [];
    for (const part of parts) {
      const p = unwrap(part);
      if (ts.isStringLiteral(p) || ts.isNoSubstitutionTemplateLiteral(p)) value += p.text;
      else if (ts.isTemplateExpression(p)) {
        value += p.head.text;
        for (const span of p.templateSpans) { value += '\u0000' + kinds.length + '\u0000'; kinds.push(kind(span.expression)); value += span.literal.text; }
      } else { value += '\u0000' + kinds.length + '\u0000'; kinds.push(kind(part)); }
    }
    out.push({ file: path.basename(file), line: line(at), value, kinds, ui: ui(at) });
  }
  function flatten(n) { n = n; return isPlus(n) ? [...flatten(n.left), ...flatten(n.right)] : [n]; }
  function visit(n) {
    if (isPlus(n) && !isPlus(n.parent)) {
      const parts = flatten(n);
      if (parts.some(p => isText(unwrap(p)))) {
        for (const p of parts) if (isText(unwrap(p))) inChain.add(unwrap(p));
        piece(parts, n);
      }
    }
    if (isText(n) && !inChain.has(n)) piece([n], n);
    ts.forEachChild(n, visit);
  }
  visit(source);
  return out;
}

// Server error messages: the text given to an exception (directly or as its message), as the screen receives it.
function server(file) {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  function visit(n) {
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && /Exception$/.test(n.expression.text) && n.arguments?.length) {
      let arg = unwrap(n.arguments[0]);
      if (ts.isObjectLiteralExpression(arg)) {
        const message = arg.properties.find(p => ts.isPropertyAssignment(p) && p.name && p.name.getText(source) === 'message');
        arg = message ? unwrap(message.initializer) : null;
      }
      if (arg && isText(arg)) {
        let value = '';
        const kinds = [];
        if (ts.isTemplateExpression(arg)) {
          value = arg.head.text;
          for (const span of arg.templateSpans) { value += '\u0000' + kinds.length + '\u0000'; kinds.push(kind(span.expression)); value += span.literal.text; }
        } else value = arg.text;
        out.push({ file: path.relative(path.join(__dirname, '..'), file).split(path.sep).join('/'), line: source.getLineAndCharacterOfPosition(arg.getStart(source)).line + 1, value, kinds, ui: true });
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(source);
  return out;
}

const args = process.argv.slice(2), serverMode = args[0] === '--server';
const files = serverMode ? args.slice(1) : args;
process.stdout.write(JSON.stringify(files.flatMap(serverMode ? server : collect)));
