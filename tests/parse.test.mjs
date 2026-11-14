import assert from 'node:assert/strict';
import test from 'node:test';
import '../mini-flow.js';

const { MiniFlow } = globalThis;

test('bend metadata cannot write to Array.prototype', () => {
  const source = 'flowchart TD\n A["x"]\n B["y"]\n A --> B\n %% mini-flow {"notes":[],"bends":[["__proto__",[1,2]],[0,[3,4]]]}';
  const graph = MiniFlow.parse(source);
  assert.equal([].bend, undefined);
  assert.deepEqual(graph.edges[0].bend, [3, 4]);
});

test('labels with line and paragraph separators round-trip', () => {
  const graph = MiniFlow.parse('flowchart TD\n A["a"]\n B["b"]\n A --> B');
  graph.nodes[0].label = 'a b';
  graph.edges[0].label = 'c d';
  const parsed = MiniFlow.parse(MiniFlow.stringify(graph));
  assert.equal(parsed.nodes[0].label, 'a b');
  assert.equal(parsed.edges[0].label, 'c d');
});

test('malformed metadata reports a clear error', () => {
  for (const metadata of ['null', '{"bends":5}', '{"notes":[null]}', '{"bends":[5]}']) {
    assert.throws(() => MiniFlow.parse('flowchart TD\n A["x"]\n %% mini-flow ' + metadata), /Invalid (metadata|note)\./);
  }
});

test('oversized sources are rejected', () => {
  assert.throws(() => MiniFlow.parse('flowchart TD\n' + ' '.repeat(1_000_001)), /too large/);
});
