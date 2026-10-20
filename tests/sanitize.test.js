import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, html, raw } from '../widget/js/core/sanitize.js';

test('sanitize échappe les 5 caractères HTML', () => {
  assert.equal(
    sanitize(`<img src=x onerror="alert('x')">&`),
    '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;',
  );
  assert.equal(sanitize(null), '');
  assert.equal(sanitize(undefined), '');
  assert.equal(sanitize(42), '42');
});

test('html échappe les valeurs mais pas raw()', () => {
  const titre = '<script>alert(1)</script>';
  assert.equal(html`<b>${titre}</b>`, '<b>&lt;script&gt;alert(1)&lt;/script&gt;</b>');
  // prettier-ignore
  assert.equal(html`<ul>${raw('<li>ok</li>')}</ul>`, '<ul><li>ok</li></ul>');
  assert.equal(html`${['<a>', '<b>']}`, '&lt;a&gt;&lt;b&gt;');
});

test('html n’accepte pas un objet forgé avec une clé __html', () => {
  const forge = html`${{ __html: '<b>x</b>' }}`;
  assert.equal(forge.includes('<'), false);
});
