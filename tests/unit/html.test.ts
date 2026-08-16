/**
 * The HTML → text reduction `WebFetch` puts in front of the model (ADR-0017).
 *
 * The cases that matter are not the pretty ones. A page is chosen by whoever
 * controls the server, so the tests are about what must *not* come through:
 * script bodies, stylesheets, and the contents of an element the response was cut
 * off in the middle of.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { decodeEntities, htmlToText, htmlTitle } from '../../src/util/html.ts';

describe('htmlToText', () => {
  test('keeps prose and drops markup', () => {
    const text = htmlToText('<div><p>Hello <b>there</b>.</p><p>Second line.</p></div>');
    assert.equal(text, 'Hello there.\nSecond line.');
  });

  test('drops script and style contents entirely', () => {
    const text = htmlToText(
      '<style>body{color:red}</style><p>Visible</p><script>fetch("http://evil.example")</script>',
    );
    assert.equal(text, 'Visible');
  });

  test('drops an unterminated script, rather than spilling it', () => {
    // A truncated response can end mid-element. Treating the unclosed tag as
    // ordinary text would put the script body in the model's context.
    const text = htmlToText('<p>Intro</p><script>var token = "leak";');
    assert.equal(text, 'Intro');
  });

  test('a tag inside a comment is not a tag', () => {
    assert.equal(htmlToText('<!-- <script>x</script> --><p>Body</p>'), 'Body');
  });

  test('headings and list items keep their structure', () => {
    const text = htmlToText('<h2>Setup</h2><ul><li>First</li><li>Second</li></ul>');
    assert.equal(text, '## Setup\n- First\n- Second');
  });

  test('collapses the whitespace HTML leaves behind', () => {
    const text = htmlToText('<p>   lots\n\n   of    space   </p>\n\n\n<p>next</p>');
    assert.equal(text, 'lots of space\nnext');
  });
});

describe('decodeEntities', () => {
  test('decodes the named and numeric forms', () => {
    assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42; &nbsp;d'), 'a & b <c> A B  d');
  });

  test('leaves an entity it does not know alone', () => {
    assert.equal(decodeEntities('&notarealentity; &#xZZ;'), '&notarealentity; &#xZZ;');
  });

  test('refuses a lone surrogate rather than producing a broken code point', () => {
    assert.equal(decodeEntities('&#xD800;'), '&#xD800;');
  });
});

describe('htmlTitle', () => {
  test('reads the title, entities and all', () => {
    assert.equal(htmlTitle('<html><head><title>A &amp; B</title></head></html>'), 'A & B');
  });

  test('is undefined when there is none', () => {
    assert.equal(htmlTitle('<html><body>x</body></html>'), undefined);
  });
});
