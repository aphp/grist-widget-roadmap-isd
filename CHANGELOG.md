# Changelog

## [Unreleased]

- Gantt: tasks, subtasks and chantiers stretch from either edge. 6 px handles (`.gbar__grip--start` / `--end`,
  ew-resize cursor) show on hover and focus; by finger, a long press selects the bar (frame, handles, no scrolling
  on it), then a press within 24 px of an edge stretches it and elsewhere moves it. Only that edge moves, in steps of
  the scale counted from its own original date, and stops on the other edge (one day at least); hours are rescaled
  at constant ETP in the same write, shown as "Heures x h → y h (ETP conservé)". No handle on milestones, bars under
  20 px, or a side clipped by the timeline. Keyboard: in the D mode, Tab / Shift+Tab cycle move, start and due date
  (announced, hinted in the tooltip; the new dates become the base of the steps); the row menu adds "Changer le
  début" and "Changer l'échéance" (not for milestones). One gesture model (`memory.gesture.edge`) for move and
  resize. A long press that selects no longer opens the form on release. Forced colors: bars, milestones, handles
  and focus rings get system-colour borders. A due date already past the bound steps back from itself instead of
  jumping to the bound.
- Gantt: tasks, subtasks, milestones and chantiers move in time by dragging their bar (mouse, pen; finger after a
  400 ms long press), duration kept. Steps follow the scale (day in Week, week in Month and Year, month in 2 years,
  day with Shift) and never pass 31 December of next year. A ghost and the tooltip show the new dates, the shift, the
  rescaled hours (the ETP holds), charges kept above the bound and children left outside (they do not follow);
  nothing is repainted during the gesture. Holding near an edge scrolls the timeline, then the period. Escape, a drop
  at the origin or off the row, or a move under 4 px (a click) write nothing. Keyboard: D on a row, or "Déplacer les
  dates" in the row menu (Shift+F10, Menu key or right click), enters a date mode; arrows step from the original
  dates (Shift: one day), Backspace returns to them, Enter saves, Escape cancels (hint in the tooltip); steps are
  announced in a persistent live region (`#gantt-live`, grouped at 300 ms, repeats re-read).
  One write per gesture through the editor (`saveDates` → `runDates`): row re-read and conflict check, rights
  re-read (`datesRight`), "Enregistrement…" on the bar until the answer, toast with "Annuler" (dates and charges are
  undone together or not at all) and "Voir les charges" when charges stay above the bound; focus returns to the row.
  A milestone with only its due date is drawn and dragged on that date. Not movable: projects, categories, "(sans
  chantier)", deduced bars, rows missing a date ("Ajouter des dates" opens the form), due date before start, rows out
  of the ISD scope or read-only; D announces why. Shared pointer controller `ui/drag.js` (the label column handle
  uses it; Escape now restores its width).
- Charges are typed in ETP or in hours per week ("h/semaine", the quotité: 35 h/week = 1 ETP) instead of total
  hours. Total hours = ETP × standard capacity of the period (leave, public holidays and slowdowns deducted), rounded
  to 0.5 h; storage unchanged (`Tasks.charges` keeps total hours). A typed value (ETP or h/week) stays shown as typed
  while the line's hours are still the ones it gives, date changes included; otherwise h/week = hours ÷ capacity ×
  35, one decimal. Retyping the shown value keeps the stored hours; another value with the same rounded total keeps
  the cell but becomes the line's ETP reference. Bound 35 h/week (50 × 35 for estimation people); errors give the
  bound in h/week with the matching total, and a too small entry names the smallest allowed h/week. Each line shows
  "= {h} h au total" in both units. Without a usable period (dates missing, inverted, or no working day), no charge
  can be typed; stored hours stay shown and kept. An h/week entry records its exact ETP as reference, so "the ETP
  holds" when dates change. The help above the lines is one sentence; the details are in the "i" tooltip. The saved
  unit preference `heures` migrates to `hsem`. ETP and h/week entries at exactly 1 ETP are accepted even when the
  period capacity rounds down to the 0.5 h step (the bound now compares the typed ETP).
- Tooltips (WCAG 1.4.13): a shown tooltip can be hovered without vanishing, and Escape hides it without moving the
  focus (and without closing the panel or dialog behind it) until the pointer leaves and the focus moves.
  Charge messages name the actual reason when ETP cannot be computed: dates missing, due date before the start, or no
  working day in the period (with a matching warning for a weekend-only task carrying charges).
- 1 ETP now means the capacity of a standard full-time person over the period, everywhere (task charges, Kanban,
  Table, Statistics, Portfolio, My tasks, load plan): 7 h per working day (weekends and French public holidays
  excluded), minus 44 days of leave a year, at 80 % in May (new) and December, 60 % in July, 50 % in August
  (`fteHours` in `core/capacity.js`, O(1) per call from cached per-year cumulative sums). It replaces "35 h per
  calendar week of the task". `hoursToEtp` / `etpToHours` now take the hours of 1 ETP; `periodDays` becomes
  `periodFte`; charge references carry `fte`. A period change is a capacity change: same-length moves that change
  the capacity rescale the hours (the ETP is kept), equal capacity keeps the cell byte for byte (form, creation
  dialog, `periodConflictCols`). A period with no working day is handled like a task without dates. Stored hours are
  not rewritten: their displayed ETP rises (about ×1.2 outside summer); an entry now above 1 ETP is kept and flagged.
  The May slowdown also applies to the load plan. "i" buttons explain the rule next to the charges unit (task form
  and creation dialogs), the Statistics ETP chart title and the load plan; texts that said "35 h par semaine" for
  the ETP are rewritten. A charge's hours are now spread over the task's days in proportion to the standard capacity
  of each day (`hoursSharer`, `spreadHours`), not evenly over calendar days: a 1-ETP task shows 1 ETP in every month
  and week (Statistics, load plan, Portfolio, My tasks); a period with no working day keeps the calendar spread. Info
  tooltips are now shifted with `translate`, so a tooltip anchored to the right stays in
  its panel.
- Gantt: rows are now ordered by start date at every level (bar start, then end, then title, undated ones last)
  instead of alphabetically (`sortTreeByDate`, copies, the model tree is untouched); chantier colours are unchanged
  and the PDF export follows the displayed order.
- Filters: the "ISD seulement" help moves from a hint under the checkbox to an "i" button with a tooltip (hover
  and keyboard focus, kept inside the window), so the filter row no longer wraps. Reusable `infoTip` in the UI kit.
- Delete from the edit form: a "Supprimer" button (tertiary, left of the form footer, task and chantier forms, shown
  only with the delete right and inside the ISD scope) deletes a task with all its subtasks (any depth) or an empty
  chantier, in one `applyUserActions` batch of `RemoveRecord`. A confirmation dialog names the item and lists the
  subtasks (10 at most, then "et n autres"); a chantier that still holds tasks is refused before anything is sent
  ("déplacez ou supprimez d'abord ses n tâches"), so is a batch another task or chantier depends on (`dependDe`).
  The writer re-reads Tasks and Chantiers just before sending, recomputes the batch, refuses if it changed since the
  confirmation, checks the scope of every row and keeps a snapshot of every data column (formulas excluded). "Annuler"
  recreates the rows with the same ids and values (`AddRecord` with a fixed id, parents first), refused if an id is
  in use again; the fixed-id `AddRecord` is accepted only when it reproduces a snapshot of the session. Essai mode
  logs everything and sends nothing. Never on Team, Projects or Disponibilites. Deletion is also refused when the
  re-read row lacks a data column known to the metadata (partial snapshot) or when another table references Tasks
  or Chantiers through a data column; "Annuler" is refused, naming the row, when a recreated row would point to a
  row that no longer exists (parent, chantier, project, dependencies, chantier projects; Projects re-read in real
  mode). A delete or restore without answer is kept when the re-read shows it happened; a delete still unknown keeps
  its snapshot so a later "Annuler" can restore the rows if they did disappear.
- Gantt: new "Chantier" color mode, now the default ("Couleur par": Étape · Statut · Chantier). Each chantier gets one
  of 7 hues (`--viz-ch-1..7`, light and dark themes, with a darker `-deep` edge and a 7 % `-band` row tint), assigned
  per project over all its chantiers sorted by title, recycled after 7 (`chantierSlots`, `chantierTone` in
  `core/gantt-data.js`), so a filter never changes a color. Dot before the chantier name, colored stroke before its
  task names, light band on its rows, task bars in its hue, chantier bar in the deep hue, done tasks faded; projects,
  categories and "(sans chantier)" stay neutral. No phase text in bars; tooltip and accessible name keep the phase
  and add "Chantier : <title>". Small-screen list and PDF export follow (light hues, adapted legend). A `ganttColorBy`
  saved as `phase` before this version was the old default, not a choice: it becomes `chantier` once
  (`ganttColorByV: 2` marker); `status` is kept.
- New "ISD seulement" filter (checkbox next to "Hors périmètre ISD aussi", removable chip, saved with the other
  filters as `isdOnly`): inside the shown projects, hides the chantiers and tasks where nobody from the ISD team
  intervenes. A task is kept if an assignee, its responsable or a person in its `charges` is an active ISD team member,
  or if one of its subtasks (any depth) is; a chantier is kept if it keeps a task or if its responsable or a
  contributor is ISD (shown empty). The rule is shared with the ISD scope (`taskInvolvesIsd`, `chantierInvolvesIsd`,
  `projectInvolvesIsd` in `core/model.js`). Applies to every filtered view, not to "Mes tâches" and "Équipe".
  Synthetic data: one added task with no ISD person.
- The widget always opens on the Gantt tab: the last viewed tab is no longer restored at load (`DEFAULT_PREFS.view`
  is now `gantt`; other preferences are kept). The first "Je suis…" no longer sets a profile home view (Management
  used to land on Synthèse); home views saved before this are reset once (`homeViewV: 2` marker in the prefs). A home
  view chosen afterwards in the Preferences still wins ("Dernière vue consultée" is now "Gantt (par défaut)",
  same stored value), and the page address parameter `vue=<tab>` (`mytasks`, `gantt`, `kanban`, `table`,
  `portfolio`, `stats`, `synthesis`, `team`) wins over everything; an unknown value is ignored.
- Gantt: resizable name column. Drag handle on the right edge of the "Élément" header (`role="separator"`, arrows
  ±16 px, Shift ±64 px, Home/End, double-click resets the default width). Width between 160 px and 60 % of the view, saved in the
  `ganttLabelWidth` pref (absent or invalid: default width), kept across re-renders and used by the PDF export.
  Full name in the title of each row name. Medium-screen default width is now 256 px (on the 16 px step).
- Fix: scroll positions jumped back to the top or left while other people edited the Feuille. Every `onRecords`
  re-read redrew the whole view, which only restored the page and the Kanban/Table scroll (not the Gantt, Portfolio,
  load plan, Stats or Synthesis areas), and focus restoration scrolled a focused card or row back into view. Now a
  re-read triggered by `onRecords` redraws nothing when the data is unchanged (fingerprint of the read tables,
  `core/reload-state.js`); a real change keeps the scroll of every `data-scroll-key` area, the page and the open
  detail panel, and focus restoration only scrolls for the quick-status card. Dev: `grist.__simulateChange(action)`
  changes the in-memory data before `onRecords`.
- Status from the card and the row (editing on, task editable): "⋯" button on Kanban cards (keyboard: "S" or
  Shift+F10 on the focused card, outside the roving focus), menu button in the Table status cell and on "Mes tâches"
  lines. Same path as the detail panel quick status (re-read before sending, closing date, essai mode, undo toast);
  scroll and focus kept, the card follows its new column.
- Team: optional `Team.aph` column (APH id) read and shown in the Team tab rows and the person card. It can be edited
  in the person form and on creation only once it is a data column in Grist; while it is the empty formula column of
  the Feuille, the field stays read-only with its reason. Strict check in the writer: 1 to 10 digits, or empty.
- Charges: people whose APH is `9999999` (`ESTIMATION_APH`, generic people such as "Data Engineer" or "Data
  Scientist" used to estimate load per profile in the roadmap) are the only ones exempt from the "1 FTE maximum per
  person" rule, in the form and in the writer; a sanity bound of 50 FTE over the period (2,000 h without dates)
  still applies. An "Estimation" badge explains it next to each of them. Every active Team row with that APH is
  exempt, however many there are (strict comparison); an inactive row is not. The widget never sets that APH nor
  changes it away: estimation people are chosen in the Feuille.
- Writer: column metadata is re-checked on every reload; a column that turned back into a formula is no longer
  written (columns are never re-enabled during a session).
- Team: `Team.aph` is accepted as a **Text or Int** data column (typing a value in the empty formula column makes Grist
  convert it, often to Int, which left the field read-only and hid the value). Read as a digit string (`aphText`:
  Int without decimals, 0 or null = empty), so the Team rows, the person card and the estimation rule (`9999999`
  as text or number) work for both. Written by the column's actual type: a number for Int (null when empty, a
  leading zero refused since Int would drop it), the string for Text. Numeric and other types stay refused
  (read-only). The writer still never sets or removes `9999999`, as text or number.
- Dev: `?ecritures=aph-donnee` makes `Team.aph` a data column (with the synthetic dataset: invented APHs, two
  active estimation people "Estimation DE" and "Estimation DS", and an inactive "Estimation DA").
  `?ecritures=aph-entier` makes it an Int data column (numbers, 0 = empty).
- Tags: assign and remove existing tags on tasks and chantiers in their forms (searchable, keyboard-accessible chip
  picker). A new name can be assigned without being declared in the sheet (column options are never changed) and is
  marked "non déclaré". Tags shown in the detail panel, an optional "Tags" column in the Table and a "Tag" filter
  under "+ Filtres". Strict writer checks and a set merge when the tags changed elsewhere meanwhile.
- ISD scope uses the ISD team (ISD profile or ISD Domaine, Management ISD included): a project led by the
  Management ISD, or where it has a chantier or task role, is no longer "hors périmètre" (sponsor or key
  contributor still counts for ISD profiles only). The ISD Domaine must contain "ISD" in its name, with no fallback
  to another Domaine. "Mes chantiers" also counts projects where I am the
  project lead, sponsor or key contributor. Projects and chantiers without tasks show "Aucune tâche" in the Gantt,
  which (like the Portfolio) no longer falls back to the empty state when only such items match. README: "Règles
  d'affichage".
- Management ISD as a full profile "Mgmt": Profile filter (PO, DA, DS, DE, Mgmt), Portfolio KPIs and weekly load
  and capacity per profile (the weekly total and bar stay on PO, DA, DS, DE), load plan rows and totals in
  Statistics (same capacity rules), `--viz-mgmt` colour.
  The charges footer of the task form now also shows the Mgmt share.

## [0.2.0] — 2026-10-20
First published version.

- Read views: Kanban, Table, Gantt, Portfolio (load per person), Statistics (including the load plan and the data to
  complete), Summary, Team; filters, "Je suis…" (who am I), detail panel, CSV and PDF exports.
- "Mes tâches" (my tasks) tab grouped by due period, weekly load banner, start view per profile.
- Load in FTE (1 FTE = 35 h per week of the task), split by profile PO, DA, DS, DE, Mgmt, Other.
- Editing (off by default, `?edition=essai` or `?edition=1&doc=<id>`, `flags.json` kill switch):
  - tasks and sub-tasks, "Personnes" block (assignees and load in FTE or hours);
  - chantiers (workstreams), creation ("Nouvelle tâche", "Nouveau chantier", "Sous-tâche"), moving a task to another
    chantier;
  - ISD team: add, edit, deactivate, unavailability periods.
- Grist plugin API and DSFR 1.15.3 served locally (no CDN request at startup).
