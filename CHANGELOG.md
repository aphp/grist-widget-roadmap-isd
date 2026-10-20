# Changelog

## [Unreleased]

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
