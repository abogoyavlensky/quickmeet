// Every English sentence a person can see must have its Russian in RU
// (resources/public/i18n.js). This finds the keys the way i18n.js does:
//
// - markup: a tag with `data-i18n` takes its value as the key, or, empty,
//   the text after the tag up to the next `<`; `data-i18n-placeholder`,
//   `-title` and `-aria-label` take their value, or, empty, the value of
//   that attribute in the same tag;
// - scripts: every `t('...')` (or "...") with a literal first argument.
//
// It prints the keys RU lacks (exit 1) and the RU keys nothing uses. A
// regex pass, not a parser: template literals and concatenations are not
// keys, which is why the pages put variables in `{name}` placeholders.
import fs from 'node:fs';
import vm from 'node:vm';

const dir = 'resources/public';
const files = ['index.html', 'signin.html', 'signup.html', 'settings.html', 'history.html', 'room.html',
  'ui.js', 'account.js'];

const attributeOf = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}(?:="([^"]*)")?(?=[\\s>/])`));
  return m ? (m[1] || '') : null;
};
const unescape = s => s.replace(/\\(.)/g, '$1');

const keys = new Map(); // key -> first file it was seen in
const add = (key, file) => { if (key && !keys.has(key)) keys.set(key, file); };

for (const file of files) {
  const src = fs.readFileSync(`${dir}/${file}`, 'utf8');
  if (file.endsWith('.html')) {
    for (const m of src.matchAll(/<[a-zA-Z][^>]*>/g)) {
      const tag = m[0];
      const text = attributeOf(tag, 'data-i18n');
      if (text !== null) {
        if (text) add(text, file);
        else add(src.slice(m.index + tag.length).split('<')[0].trim(), file);
      }
      for (const attribute of ['placeholder', 'title', 'aria-label']) {
        const mark = attributeOf(tag, `data-i18n-${attribute}`);
        if (mark !== null) add(mark || attributeOf(tag, attribute), file);
      }
    }
  }
  for (const m of src.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) add(unescape(m[2]), file);
}

// RU, by running i18n.js against just enough of a browser.
const source = fs.readFileSync(`${dir}/i18n.js`, 'utf8');
const RU = vm.runInNewContext(`${source}\n;RU`, {
  navigator: { language: 'en' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: { addEventListener() {}, documentElement: {} },
});

const missing = [...keys].filter(([key]) => !(key in RU));
const unused = Object.keys(RU).filter(key => !keys.has(key));
for (const [key, file] of missing) console.log(`missing  ${JSON.stringify(key)}  (${file})`);
for (const key of unused) console.log(`unused   ${JSON.stringify(key)}`);
console.log(`${keys.size} keys, ${missing.length} missing, ${unused.length} unused`);
process.exit(missing.length ? 1 : 0);
