/** Contrôleur de pointeur commun (ui/drag.js) : seuils, appui long, Échap, bord, nettoyage. */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DRAG, edgeSide, trackPointer as realTrack } from '../widget/js/ui/drag.js';

// Un seul geste actif à la fois : chaque test referme le sien.
const opened = [];
const trackPointer = (d, h) => {
  const handle = realTrack(d, h);
  opened.push(handle);
  return handle;
};
afterEach(() => {
  while (opened.length) opened.pop().cancel('test');
});

/** Faux window : écouteurs honorant `signal`, dispatch dans l'ordre d'inscription. */
function fakeWindow() {
  const list = [];
  return {
    list,
    bubble: [], // écouteurs de document/éléments, en phase de bulle
    addEventListener(type, fn, opts = {}) {
      const rec = { type, fn, capture: opts === true || !!opts.capture, passive: opts.passive };
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
        propagationStopped: false,
        stopPropagation() {
          this.propagationStopped = true;
        },
        stopImmediatePropagation() {
          this.stopped = true;
          this.propagationStopped = true;
        },
        ...props,
      };
      for (const r of [...list]) {
        if (r.type === type && !e.stopped) r.fn(e);
      }
      if (!e.propagationStopped) for (const fn of this.bubble) fn(e);
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
const types = (s) => s.win.list.map((r) => r.type).sort();
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
  // boîte étroite : le bord le plus proche l'emporte, égalité → 0
  const narrow = { left: 0, right: 40 };
  assert.equal(edgeSide(30, narrow), 1);
  assert.equal(edgeSide(10, narrow), -1);
  assert.equal(edgeSide(20, narrow), 0);
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
  assert.deepEqual(types(s), ['click', 'pointerdown']); // seul le clic à avaler reste
});

test('Échap pendant un glisser : écouteur capture de kit.js (stopPropagation) n’empêche pas l’annulation', () => {
  const s = setup();
  s.win.addEventListener(
    'keydown',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  trackPointer(down(), s.handlers);
  s.win.emit('pointermove', { clientX: 110 });
  s.win.emit('keydown', { key: 'Escape' });
  assert.deepEqual(s.calls, [['start'], ['cancel', 'escape']]);
});

test('Échap pendant un glisser : ni le panneau ni la boîte de dialogue ne le voient', () => {
  const s = setup();
  const seen = [];
  s.win.bubble.push((e) => e.type === 'keydown' && seen.push(e.key)); // chrome.js / dialog.js, phase de bulle
  s.win.addEventListener('keydown', () => seen.push('later-capture'), true); // inscrit avant le geste
  trackPointer(down(), s.handlers);
  s.win.addEventListener('keydown', () => seen.push('after-gesture'), true);
  s.win.emit('pointermove', { clientX: 110 });
  const e = s.win.emit('keydown', { key: 'Escape' });
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(seen, ['later-capture']);
});

test('Échap avant le démarrage : l’événement n’est pas touché', () => {
  const s = setup();
  const seen = [];
  s.win.bubble.push((e) => seen.push(e.key));
  trackPointer(down(), s.handlers);
  const e = s.win.emit('keydown', { key: 'Escape' });
  assert.equal(e.defaultPrevented, false);
  assert.deepEqual(seen, ['Escape']);
});

test('Échap : écouteur en phase de capture, inscrit dès l’appui', () => {
  const s = setup();
  trackPointer(down(), s.handlers);
  assert.ok(s.win.list.find((r) => r.type === 'keydown')?.capture);
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
    assert.deepEqual(types(s), []); // pas de clic à avaler après une annulation
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
  assert.deepEqual(types(s), []);
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
  assert.deepEqual(types(s), ['click', 'pointerdown']);
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

test('Échap pendant un glisser puis pointerup : le clic suivant est avalé une fois', () => {
  const s = setup();
  trackPointer(down(), s.handlers);
  s.win.emit('pointermove', { clientX: 110 });
  s.win.emit('keydown', { key: 'Escape' });
  s.win.emit('pointerup');
  assert.equal(s.win.emit('click').defaultPrevented, true);
  assert.equal(s.win.emit('click').defaultPrevented, false);
  assert.deepEqual(types(s), []);
});

test('clic après pointercancel, blur ou cancel() programmatique : non avalé', () => {
  for (const end of ['pointercancel', 'blur', 'manual']) {
    const s = setup();
    const h = trackPointer(down(), s.handlers);
    s.win.emit('pointermove', { clientX: 110 });
    if (end === 'manual') h.cancel('refresh');
    else s.win.emit(end);
    assert.equal(s.win.emit('click').defaultPrevented, false, end);
    opened.pop().cancel('test');
  }
});

test('clic après un dépôt : avalé une fois ; un nouvel appui retire l’écouteur', () => {
  const s = setup();
  trackPointer(down(), s.handlers);
  s.win.emit('pointermove', { clientX: 110 });
  s.win.emit('pointerup');
  s.win.emit('pointerdown');
  assert.deepEqual(types(s), []);
  assert.equal(s.win.emit('click').defaultPrevented, false);
});

test('Échap puis aucun relâchement : rien n’est avalé, l’écouteur d’attente tombe au prochain appui', () => {
  const s = setup();
  trackPointer(down(), s.handlers);
  s.win.emit('pointermove', { clientX: 110 });
  s.win.emit('keydown', { key: 'Escape' });
  s.win.emit('pointerdown');
  assert.deepEqual(types(s), []);
  assert.equal(s.win.emit('click').defaultPrevented, false);
});

test('second trackPointer pendant un geste : refusé, poignée sans effet', () => {
  const s = setup();
  const s2 = setup();
  trackPointer(down(), s.handlers);
  const h2 = realTrack(down({ pointerId: 2 }), s2.handlers);
  assert.equal(s2.win.list.length, 0);
  h2.cancel('x');
  s.win.emit('pointermove', { clientX: 110 });
  assert.deepEqual(s.calls, [['start']]);
  s.win.emit('pointerup');
  const h3 = trackPointer(down(), s2.handlers); // libre à nouveau
  assert.ok(s2.win.list.length > 0);
  h3.cancel('x');
});

test('multi-touch : un second doigt n’annule ni ne déplace le geste', () => {
  const s = setup();
  trackPointer(down(), s.handlers);
  s.win.emit('pointermove', { clientX: 110 });
  s.win.emit('pointercancel', { pointerId: 2 });
  s.win.emit('pointermove', { clientX: 300, pointerId: 2 });
  s.flush();
  assert.deepEqual(s.calls, [['start'], ['move', 10, 0]]);
});

test('setPointerCapture sur la cible de l’appui (erreur ignorée)', () => {
  const s = setup();
  const got = [];
  trackPointer(down({ target: { setPointerCapture: (id) => got.push(id) } }), s.handlers);
  assert.deepEqual(got, [1]);
  s.win.emit('pointerup');
  const s2 = setup();
  assert.doesNotThrow(() =>
    trackPointer(
      down({
        target: {
          setPointerCapture() {
            throw new Error('x');
          },
        },
      }),
      s2.handlers,
    ),
  );
});

test('souris : pointermove sans bouton enfoncé = annulation sans dépôt ni clic avalé', () => {
  const s = setup();
  trackPointer(down(), s.handlers);
  s.win.emit('pointermove', { clientX: 110, buttons: 1 });
  s.win.emit('pointermove', { clientX: 120, buttons: 0 });
  assert.deepEqual(s.calls, [['start'], ['cancel', 'cancel']]);
  assert.deepEqual(types(s), []);
  assert.equal(s.win.emit('click').defaultPrevented, false);
});

test('doigt : touchmove non passif et contextmenu bloqués, retirés en fin de geste', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  trackPointer(down({ pointerType: 'touch' }), s.handlers);
  assert.ok(types(s).includes('contextmenu'));
  assert.equal(types(s).includes('touchmove'), false);
  assert.equal(s.win.emit('contextmenu').defaultPrevented, true);
  t.mock.timers.tick(400);
  const tm = s.win.list.find((r) => r.type === 'touchmove');
  assert.ok(tm);
  assert.equal(tm.passive, false);
  assert.equal(s.win.emit('touchmove').defaultPrevented, true);
  s.win.emit('pointermove', { clientX: 112, pointerType: 'touch' });
  s.win.emit('pointercancel', { pointerType: 'touch' });
  assert.deepEqual(types(s), []);
});

test('souris : ni touchmove ni contextmenu', () => {
  const s = setup();
  trackPointer(down(), s.handlers);
  assert.deepEqual(
    types(s).filter((x) => x === 'touchmove' || x === 'contextmenu'),
    [],
  );
});

test('onEdge qui lève : la chaîne de minuteurs continue', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = [];
  t.mock.method(console, 'error', (e) => errors.push(e));
  let n = 0;
  const s = setup({
    edgeBox: () => ({ left: 0, right: 200 }),
    onEdge: () => {
      n++;
      throw new Error('boom');
    },
  });
  trackPointer(down({ clientX: 100 }), s.handlers);
  s.win.emit('pointermove', { clientX: 195 });
  t.mock.timers.tick(500);
  t.mock.timers.tick(500);
  assert.equal(n, 2);
  assert.equal(errors.length, 2);
});

test('onStart qui lève : geste terminé (aucun écouteur, nouveau geste possible), erreur relancée', () => {
  const s = setup({
    onStart: () => {
      throw new Error('boum');
    },
  });
  trackPointer(down(), s.handlers);
  assert.throws(() => s.win.emit('pointermove', { clientX: 110 }), /boum/);
  assert.equal(s.win.list.length, 0);
  assert.equal(s.win.emit('click').defaultPrevented, false);
  const t = setup();
  trackPointer(down(), t.handlers);
  t.win.emit('pointermove', { clientX: 110 });
  assert.deepEqual(t.calls, [['start']]);
});

test('doigt, immediate (élément en touch-action: none) : pas d’appui long, seuil de 8 px', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup({ immediate: true });
  trackPointer(down({ pointerType: 'touch' }), s.handlers);
  s.win.emit('pointermove', { clientX: 105, pointerType: 'touch' });
  assert.deepEqual(s.calls, []);
  s.win.emit('pointermove', { clientX: 112, pointerType: 'touch' });
  assert.deepEqual(s.calls, [['start']]);
  t.mock.timers.tick(1000);
  assert.equal(s.doc.documentElement.style.touchAction, '');
  s.win.emit('pointerup', { pointerType: 'touch' });
  assert.deepEqual(s.calls.at(-1), ['drop']);
});

test('stylet : survol sans contact (buttons 0) après un relâchement perdu = annulation ; doigt jamais', (t) => {
  const s = setup();
  trackPointer(down({ pointerType: 'pen' }), s.handlers);
  s.win.emit('pointermove', { clientX: 110, buttons: 1, pointerType: 'pen' });
  s.win.emit('pointermove', { clientX: 120, buttons: 0, pointerType: 'pen' });
  assert.deepEqual(s.calls, [['start'], ['cancel', 'cancel']]);
  s.win.emit('pointerup', { pointerType: 'pen' });
  assert.equal(s.calls.length, 2);
  // Doigt : buttons n'est pas fiable, aucune annulation pour cela
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup();
  trackPointer(down({ pointerType: 'touch' }), f.handlers);
  t.mock.timers.tick(400);
  f.win.emit('pointermove', { clientX: 120, buttons: 0, pointerType: 'touch' });
  assert.deepEqual(f.calls, [['start']]);
});
