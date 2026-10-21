/**
 * Contrôleur de pointeur commun aux glisser-déposer (Gantt, Kanban) : seuils, appui long du doigt, Échap,
 * détection du bord, clic avalé après un vrai glisser. Aucun écouteur par élément : tout est posé sur `window`
 * pour la durée du geste (un AbortController par geste).
 */

/** Seuils (px) et délais : souris et stylet 4 px ; doigt 8 px après un appui long de 400 ms. */
export const DRAG = Object.freeze({ mouse: 4, touch: 8, longPress: 400, edge: 32, edgeDelay: 500 });

/** Durée pendant laquelle le clic qui suit un glisser est avalé (ms). */
const CLICK_WINDOW = 100;
/** Après Échap pendant un glisser, le relâchement peut venir bien plus tard. */
const RELEASE_WINDOW = 10000;

/** Un seul geste à la fois (multi-touch, second appui). */
let active = false;

/** Côté du bord atteint par x dans box (zone DRAG.edge px), 0 sinon. Pure. */
export function edgeSide(x, box, zone = DRAG.edge) {
  if (!box) return 0;
  const right = x >= box.right - zone;
  const left = x <= box.left + zone;
  if (right && left) {
    // boîte étroite : le bord le plus proche l'emporte, égalité → 0
    const dr = box.right - x;
    const dl = x - box.left;
    return dr < dl ? 1 : dl < dr ? -1 : 0;
  }
  return right ? 1 : left ? -1 : 0;
}

/** Avale le prochain clic (capture sur window), puis se retire : clic, nouvel appui ou délai (le premier). */
function swallowNextClick(win, ms = CLICK_WINDOW) {
  const ac = new AbortController();
  let timer = null;
  const end = () => {
    if (timer) clearTimeout(timer);
    ac.abort();
  };
  win.addEventListener('pointerdown', end, { capture: true, signal: ac.signal });
  win.addEventListener(
    'click',
    (e) => {
      e.preventDefault();
      e.stopImmediatePropagation?.();
      end();
    },
    { capture: true, signal: ac.signal },
  );
  timer = setTimeout(end, ms);
  timer?.unref?.();
}

/** Après Échap pendant un glisser : le clic qui suit le relâchement est avalé (jamais sans relâchement). */
function swallowAfterRelease(win) {
  const ac = new AbortController();
  let timer = null;
  const end = () => {
    if (timer) clearTimeout(timer);
    ac.abort();
  };
  win.addEventListener(
    'pointerup',
    () => {
      end();
      swallowNextClick(win);
    },
    { capture: true, signal: ac.signal },
  );
  win.addEventListener('pointerdown', end, { capture: true, signal: ac.signal });
  timer = setTimeout(end, RELEASE_WINDOW);
  timer?.unref?.();
}

/**
 * Démarre le suivi d'un appui. Les écouteurs sont sur window (signal AbortController) : un nouveau rendu de la vue
 * ne coupe pas le geste. Un appui sous le seuil reste un clic ; le clic qui suit un vrai glisser est avalé.
 * `onMove` est appelé au plus une fois par image (requestAnimationFrame) avec le dernier écart ; `onDrop` vide
 * d'abord le mouvement en attente. Écouteurs optionnels de test : `win`, `doc`, `raf`.
 * @param {PointerEvent} down
 * @param {{onStart(e):boolean|void, onMove(e, dx:number, dy:number):void, onDrop(e):void, onCancel(why:string):void,
 *   onEdge?(side:-1|1):void, edgeBox?():DOMRect|null, win?:Window, doc?:Document,
 *   raf?(fn:Function):unknown}} handlers  onStart rend false pour refuser le geste
 * @returns {{cancel(why:string):void}}
 */
export function trackPointer(down, handlers) {
  if (active) return { cancel() {} };
  active = true;
  const win = handlers.win ?? globalThis.window;
  const root = (handlers.doc ?? globalThis.document)?.documentElement;
  const raf = handlers.raf ?? ((fn) => win.requestAnimationFrame(fn));
  const touch = down.pointerType === 'touch';
  const threshold = touch ? DRAG.touch : DRAG.mouse;
  const ac = new AbortController();
  const opts = { signal: ac.signal };
  const x0 = down.clientX;
  const y0 = down.clientY;
  let armed = !touch; // doigt : armé après l'appui long
  let dragging = false;
  let done = false;
  let pendingMove = null;
  let queued = false;
  let longTimer = null;
  let edgeTimer = null;
  let edgeNow = 0;
  let box = null;
  let prevTouchAction = null;

  const clearEdge = () => {
    if (edgeTimer) clearTimeout(edgeTimer);
    edgeTimer = null;
    edgeNow = 0;
  };
  const finish = () => {
    done = true;
    pendingMove = null;
    if (longTimer) clearTimeout(longTimer);
    longTimer = null;
    clearEdge();
    if (prevTouchAction !== null && root) root.style.touchAction = prevTouchAction;
    prevTouchAction = null;
    ac.abort();
    active = false;
  };
  const flush = () => {
    const e = pendingMove;
    pendingMove = null;
    if (!e || done || !dragging) return;
    handlers.onMove(e, e.clientX - x0, e.clientY - y0);
  };
  const frame = () => {
    queued = false;
    flush();
  };
  const cancel = (why) => {
    if (done) return;
    const was = dragging;
    finish();
    if (was) {
      handlers.onCancel(why);
      if (why === 'escape') swallowAfterRelease(win);
    }
  };
  const mine = (e) => e.pointerId === down.pointerId;
  const scheduleEdge = (side) => {
    edgeTimer = setTimeout(() => {
      if (done || edgeNow !== side) return;
      try {
        handlers.onEdge?.(side);
      } catch (err) {
        console.error(err); // la chaîne continue : une erreur d'un appel ne coupe pas le défilement
      }
      scheduleEdge(side);
    }, DRAG.edgeDelay);
  };
  const trackEdge = (x) => {
    const side = handlers.onEdge ? edgeSide(x, box) : 0;
    if (side === edgeNow) return;
    clearEdge();
    edgeNow = side;
    if (side) scheduleEdge(side);
  };

  win.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      if (dragging) {
        // l'Échap du glisser n'atteint ni le panneau, ni le popover, ni la boîte de dialogue
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      cancel('escape');
    },
    { ...opts, capture: true },
  );
  win.addEventListener('pointercancel', (e) => mine(e) && cancel('cancel'), opts);
  win.addEventListener('blur', () => cancel('cancel'), opts);
  win.addEventListener(
    'pointermove',
    (e) => {
      if (done || !mine(e)) return;
      if (e.pointerType === 'mouse' && e.buttons === 0) {
        cancel('cancel'); // relâchement manqué (hors de la fenêtre)
        return;
      }
      if (!dragging) {
        const far = Math.hypot(e.clientX - x0, e.clientY - y0) >= threshold;
        if (!armed) {
          if (far) finish(); // le doigt a bougé avant l'appui long : le navigateur fait défiler
          return;
        }
        if (!far) return;
        let started;
        try {
          started = handlers.onStart(e);
        } catch (err) {
          finish(); // geste terminé avant de relancer : aucun écouteur ni verrou ne reste
          throw err;
        }
        if (started === false) {
          finish();
          return;
        }
        dragging = true;
        box = handlers.edgeBox?.() ?? null;
      }
      pendingMove = e;
      if (handlers.onEdge) trackEdge(e.clientX);
      if (!queued) {
        queued = true;
        raf(frame);
      }
    },
    opts,
  );
  win.addEventListener(
    'pointerup',
    (e) => {
      if (done || !mine(e)) return;
      if (!dragging) {
        finish();
        return;
      }
      flush();
      finish();
      handlers.onDrop(e);
      swallowNextClick(win);
    },
    opts,
  );

  try {
    down.target?.setPointerCapture?.(down.pointerId);
  } catch {
    /* pointeur déjà relâché : sans importance */
  }
  if (touch) {
    win.addEventListener('contextmenu', (e) => e.preventDefault(), { ...opts, capture: true });
    longTimer = setTimeout(() => {
      longTimer = null;
      if (done) return;
      armed = true;
      // touch-action est lu au début du toucher : touchmove non passif pour que le navigateur ne défile pas
      win.addEventListener('touchmove', (e) => e.preventDefault(), { ...opts, passive: false });
      if (root) {
        prevTouchAction = root.style.touchAction ?? '';
        root.style.touchAction = 'none';
      }
    }, DRAG.longPress);
  }

  return { cancel: (why) => cancel(why) };
}
