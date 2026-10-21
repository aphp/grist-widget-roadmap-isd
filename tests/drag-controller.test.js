/** Contrôleur de pointeur commun (ui/drag.js) : seuils, appui long, Échap, bord, nettoyage. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRAG, edgeSide, trackPointer } from '../widget/js/ui/drag.js';

/** Faux window : écouteurs honorant `signal`, dispatch dans l'ordre d'inscription. */
function fakeWindow() {
  const list = [];
  return {
    list,
    addEventListener(type, fn, opts = {}) {
      const rec = { type, fn, capture: opts === true || !!opts.capture };
      list.push(rec);
      opts.signal?.addEventListener('abort', () => {
        const i = list.indexOf(rec);
        if (i >= 0) list.splice(i, 1);
      });
    },
    emit(type, props = {}) {
      const e = {
        type,
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 100,
        clientY: 50,
        defaultPrevented: false,
        stopped: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopImmediatePropagation() {
          this.stopped = true;
        },
        ...props,
      };
      for (const r of [...list]) {
        if (r.type === type && !e.stopped) r.fn(e);
      }
      return e;
    },
  };
}

function setup(over = {}) {
  const win = fakeWindow();
  const calls = [];
  const frames = [];
  const doc = { documentElement: { style: { touchAction: '' } } };
  const handlers = {
    win,
    doc,
    raf: (fn) => frames.push(fn),
    onStart: () => void calls.push(['start']),
    onMove: (e, dx, dy) => calls.push(['move', dx, dy]),
    onDrop: () => calls.push(['drop']),
    onCancel: (why) => calls.push(['cancel', why]),
    onEdge: (side) => calls.push(['edge', side]),
    ...over,
  };
  const flush = () => frames.splice(0).forEach((f) => f());
  return { win, calls, frames, flush, doc, handlers };
}
const down = (props = {}) => ({ pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 50, ...props });

test('edgeSide', () => {
  const box = { left: 0, right: 200 };
  assert.equal(edgeSide(190, box), 1);
  assert.equal(edgeSide(10, box), -1);
  assert.equal(edgeSide(100, box), 0);
  assert.equal(edgeSide(168, box), 1);
  assert.equal(edgeSide(167, box), 0);
  assert.equal(edgeSide(190, null), 0);
  assert.equal(edgeSide(190, box, 5), 0);
});

test('DRAG est figé', () => {
  assert.deepEqual({ ...DRAG }, { mouse: 4, touch: 8, longPress: 400, edge: 32, edgeDelay: 500 });
  assert.ok(Object.isFrozen(DRAG));
});

test('3 px puis relâcher : ni onStart ni onDrop, clic non avalé', () => {
  const s = setup();
  trackPointer(down(), s.handlers);
  s.win.emit('pointermove', { clientX: 103 });
  s.win.emit('pointerup', { clientX: 103 });
  assert.deepEqual(s.calls, []);
  assert.equal(s.win.list.length, 0);
  assert.equal(s.win.emit('click').defaultPrevented, false);
});

test('10 px : onStart, onMove(10, 0) à la frame, onDrop ; le clic suivant est avalé une seule fois', () => {
  const s = setup();
  trackPointer(down(), s.handlers);
  s.win.emit('pointermove', { clientX: 110 });
  assert.deepEqual(s.calls, [['start']]);
  s.flush();
  assert.deepEqual(s.calls, [['start'], ['move', 10, 0]]);
  s.win.emit('pointerup', { clientX: 110 });
  assert.deepEqual(s.calls.at(-1), ['drop']);
  const click = s.win.emit('click');
  assert.equal(click.defaultPrevented, true);
  assert.equal(click.stopped, true);
  assert.equal(s.win.emit('click').defaultPrevented, false);
  assert.equal(s.win.list.length, 0);
});

test('le clic avalé expire après un court délai', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  trackPointer(down(), s.handlers);
  s.win.emit('pointermove', { clientX: 110 });
  s.win.emit('pointerup');
  t.mock.timers.tick(1000);
  assert.equal(s.win.list.length, 0);
  assert.equal(s.win.emit('click').defaultPrevented, false);
});

test('pointermove regroupé : un onMove par frame avec le dernier dx/dy', () => {
  const s = setup();
  trackPointer(down(), s.handlers);
  s.win.emit('pointermove', { clientX: 110 });
  s.win.emit('pointermove', { clientX: 120, clientY: 55 });
  s.win.emit('pointermove', { clientX: 130, clientY: 60 });
  assert.equal(s.frames.length, 1);
  s.flush();
  assert.deepEqual(s.calls, [['start'], ['move', 30, 10]]);
});

test('onDrop vide d’abord le mouvement en attente', () => {
  const s = setup();
  trackPointer(down(), s.handlers);
  s.win.emit('pointermove', { clientX: 110 });
  s.win.emit('pointermove', { clientX: 140 });
  s.win.emit('pointerup', { clientX: 140 });
  assert.deepEqual(s.calls, [['start'], ['move', 40, 0], ['drop']]);
  s.flush();
  assert.equal(s.calls.length, 3);
});

test('onStart rend false : geste refusé, plus rien, clic non avalé', () => {
  const s = setup({ onStart: () => false });
  trackPointer(down(), s.handlers);
  s.win.emit('pointermove', { clientX: 120 });
  assert.equal(s.win.list.length, 0);
  s.win.emit('pointerup');
  assert.deepEqual(s.calls, []);
  assert.equal(s.win.emit('click').defaultPrevented, false);
});

test('Échap pendant le geste : onCancel("escape"), pas de onDrop, plus d’écouteur', () => {
  const s = setup();
  trackPointer(down(), s.handlers);
  s.win.emit('pointermove', { clientX: 110 });
  s.win.emit('keydown', { key: 'Escape' });
  s.win.emit('pointerup');
  assert.deepEqual(s.calls, [['start'], ['cancel', 'escape']]);
  assert.deepEqual(
    s.win.list.map((r) => r.type),
    ['click'],
  ); // seul le clic à avaler reste
});

test('Échap l’emporte sur un écouteur capture qui stoppe la propagation (info-bulle de kit.js)', () => {
  const s = setup();
  let seen = 0;
  s.win.addEventListener('keydown', () => seen++, true); // comme kit.js : stopPropagation + preventDefault
  s.win.addEventListener('keydown', (e) => e.preventDefault(), true);
  trackPointer(down(), s.handlers);
  s.win.emit('pointermove', { clientX: 110 });
  s.win.emit('keydown', { key: 'Escape' });
  assert.equal(seen, 1);
  assert.deepEqual(s.calls, [['start'], ['cancel', 'escape']]);
});

test('Échap : écouteur en phase de capture, inscrit dès l’appui', () => {
  const s = setup();
  trackPointer(down(), s.handlers);
  const k = s.win.list.find((r) => r.type === 'keydown');
  assert.ok(k.capture);
  assert.equal(
    k,
    s.win.list.find((r) => r.type === 'keydown'),
  );
});

test('Échap, autre touche : sans effet', () => {
  const s = setup();
  trackPointer(down(), s.handlers);
  s.win.emit('pointermove', { clientX: 110 });
  s.win.emit('keydown', { key: 'a' });
  assert.deepEqual(s.calls, [['start']]);
});

test('pointercancel et blur : onCancel("cancel"), onMove en attente abandonné', () => {
  for (const type of ['pointercancel', 'blur']) {
    const s = setup();
    trackPointer(down(), s.handlers);
    s.win.emit('pointermove', { clientX: 110 });
    s.win.emit(type);
    s.flush();
    assert.deepEqual(s.calls, [['start'], ['cancel', 'cancel']], type);
    assert.deepEqual(
      s.win.list.map((r) => r.type),
      ['click'],
    ); // seul le clic à avaler reste
  }
});

test('annulation avant le seuil : silencieuse', () => {
  const s = setup();
  trackPointer(down(), s.handlers);
  s.win.emit('keydown', { key: 'Escape' });
  assert.deepEqual(s.calls, []);
  assert.equal(s.win.list.length, 0);
});

test('cancel() manuel : onCancel avec la raison, idempotent', () => {
  const s = setup();
  const h = trackPointer(down(), s.handlers);
  s.win.emit('pointermove', { clientX: 110 });
  h.cancel('refresh');
  h.cancel('again');
  assert.deepEqual(s.calls, [['start'], ['cancel', 'refresh']]);
  assert.deepEqual(
    s.win.list.map((r) => r.type),
    ['click'],
  ); // seul le clic à avaler reste
});

test('autre pointeur ignoré', () => {
  const s = setup();
  trackPointer(down(), s.handlers);
  s.win.emit('pointermove', { clientX: 150, pointerId: 2 });
  s.win.emit('pointerup', { pointerId: 2 });
  assert.deepEqual(s.calls, []);
  assert.equal(s.win.list.length > 0, true);
});

test('stylet : seuil de 4 px comme la souris', () => {
  const s = setup();
  trackPointer(down({ pointerType: 'pen' }), s.handlers);
  s.win.emit('pointermove', { clientX: 104, pointerType: 'pen' });
  assert.deepEqual(s.calls, [['start']]);
});

test('doigt : mouvement de 12 px à 100 ms : abandon', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  trackPointer(down({ pointerType: 'touch' }), s.handlers);
  t.mock.timers.tick(100);
  s.win.emit('pointermove', { clientX: 112, pointerType: 'touch' });
  assert.equal(s.win.list.length, 0);
  t.mock.timers.tick(1000);
  s.win.emit('pointermove', { clientX: 140, pointerType: 'touch' });
  assert.deepEqual(s.calls, []);
  assert.equal(s.doc.documentElement.style.touchAction, '');
});

test('doigt : immobile 400 ms puis mouvement : onStart, touch-action none puis restauré', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  s.doc.documentElement.style.touchAction = 'pan-y';
  trackPointer(down({ pointerType: 'touch' }), s.handlers);
  t.mock.timers.tick(399);
  assert.equal(s.doc.documentElement.style.touchAction, 'pan-y');
  s.win.emit('pointermove', { clientX: 103, pointerType: 'touch' });
  t.mock.timers.tick(1);
  assert.equal(s.doc.documentElement.style.touchAction, 'none');
  s.win.emit('pointermove', { clientX: 105, pointerType: 'touch' });
  assert.deepEqual(s.calls, []);
  s.win.emit('pointermove', { clientX: 112, pointerType: 'touch' });
  assert.deepEqual(s.calls, [['start']]);
  s.win.emit('pointerup', { pointerType: 'touch' });
  assert.equal(s.doc.documentElement.style.touchAction, 'pan-y');
  assert.deepEqual(
    s.win.list.map((r) => r.type),
    ['click'],
  );
});

test('doigt : relâché après l’appui long sans bouger : rien, touch-action restauré', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  trackPointer(down({ pointerType: 'touch' }), s.handlers);
  t.mock.timers.tick(400);
  s.win.emit('pointerup', { pointerType: 'touch' });
  assert.deepEqual(s.calls, []);
  assert.equal(s.doc.documentElement.style.touchAction, '');
  assert.equal(s.win.list.length, 0);
  assert.equal(s.win.emit('click').defaultPrevented, false);
});

test('doigt : le minuteur d’appui long est annulé par un relâchement précoce', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  trackPointer(down({ pointerType: 'touch' }), s.handlers);
  s.win.emit('pointerup', { pointerType: 'touch' });
  t.mock.timers.tick(1000);
  assert.equal(s.doc.documentElement.style.touchAction, '');
});

test('bord : 600 ms au bord droit → onEdge(1) une fois, 1 100 ms → deux fois', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const box = { left: 0, right: 200 };
  const s = setup({ edgeBox: () => box });
  trackPointer(down({ clientX: 100 }), s.handlers);
  s.win.emit('pointermove', { clientX: 195 });
  t.mock.timers.tick(499);
  assert.equal(s.calls.filter((c) => c[0] === 'edge').length, 0);
  t.mock.timers.tick(101);
  assert.equal(s.calls.filter((c) => c[0] === 'edge').length, 1);
  t.mock.timers.tick(500);
  const edges = s.calls.filter((c) => c[0] === 'edge');
  assert.deepEqual(edges, [
    ['edge', 1],
    ['edge', 1],
  ]);
  s.win.emit('pointerup');
  t.mock.timers.tick(5000);
  assert.equal(s.calls.filter((c) => c[0] === 'edge').length, 2);
});

test('bord : quitter le bord arrête, changer de côté repart de zéro, edgeBox lu une fois', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const s = setup({ edgeBox: () => (reads++, { left: 0, right: 200 }) });
  trackPointer(down({ clientX: 100 }), s.handlers);
  s.win.emit('pointermove', { clientX: 195 });
  t.mock.timers.tick(400);
  s.win.emit('pointermove', { clientX: 100 });
  t.mock.timers.tick(2000);
  assert.equal(s.calls.filter((c) => c[0] === 'edge').length, 0);
  s.win.emit('pointermove', { clientX: 5 });
  t.mock.timers.tick(500);
  assert.deepEqual(
    s.calls.filter((c) => c[0] === 'edge'),
    [['edge', -1]],
  );
  assert.equal(reads, 1);
});

test('bord : annulation arrête le minuteur', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup({ edgeBox: () => ({ left: 0, right: 200 }) });
  trackPointer(down({ clientX: 100 }), s.handlers);
  s.win.emit('pointermove', { clientX: 195 });
  s.win.emit('keydown', { key: 'Escape' });
  t.mock.timers.tick(3000);
  assert.equal(s.calls.filter((c) => c[0] === 'edge').length, 0);
});

test('aucun écouteur ne reste après un geste complet', () => {
  const s = setup();
  trackPointer(down(), s.handlers);
  assert.ok(s.win.list.length > 0);
  s.win.emit('pointermove', { clientX: 110 });
  s.win.emit('pointerup');
  s.win.emit('click');
  assert.equal(s.win.list.length, 0);
});
