/**
 * Sidebar-selector test against the REAL DOM shapes the phone reported.
 *
 * The diagnostic from the device returned:
 *   found:false, handleLeft:"-11px", rootCandidates:[
 *     "wtg9ga_root 280x2096 @0",      <- the sidebar
 *     "GAkraW_root 272x1644 @8",
 *     "_5Qcc8a_root 260x50 @10",
 *     "an3WzG_root 744x2096 @280",    <- the content column
 *     "V4vHZW_root 737x29171 @280",
 *     "BE0jCW_root 673x0 @312" ]
 *
 * The old predicate required a sibling token (…_collapsed / _logoRow / …) on the
 * SAME element, but `wtg9ga_root` carries only that one class: those tokens live
 * on its children. So it matched nothing and the handle fell back to -11px.
 *
 * Run:  node tools/test-sidebar-selector.mjs
 */

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name} ${detail}`)
}

/** The predicate exactly as shipped in SIDEBAR_COLUMN_JS. */
function isSidebar(node) {
  if (!node || node.tagName !== 'DIV') return false
  const cls = typeof node.className === 'string' ? node.className : ''
  if (!/(^|\s)[A-Za-z0-9_-]+_root(\s|$)/.test(cls)) return false
  const box = node.getBoundingClientRect()
  // The sidebar is the left column: tall, on the left EDGE, narrower than the frame.
  if (box.height < 200 || box.width < 40) return false
  if (box.left > 24 || box.width > 800 * 0.6) return false
  return /[A-Za-z0-9_-]+_(panelList|logoRow|newSession|footArea)/.test((node.innerHTML ?? '').slice(0, 4000))
}

/** Build a fake node with the geometry and markup the phone reported. */
function node(className, box, innerHTML = '') {
  return { tagName: 'DIV', className, innerHTML, getBoundingClientRect: () => box }
}

function box(width, height, left) {
  return { width, height, left, right: left + width, top: 0, bottom: height }
}

console.log('1) the real sidebar element is recognised (was: not found)')
{
  // The column carries only `wtg9ga_root`; its children carry the module tokens.
  const sidebar = node('wtg9ga_root', box(280, 2096, 0), '<div class="wtg9ga_logoRow"></div><div class="wtg9ga_panelList"></div>')
  check('wtg9ga_root 280x2096 @0 matches', isSidebar(sidebar) === true)
}

console.log('2) the other _root columns are rejected')
{
  const content = node('an3WzG_root', box(744, 2096, 280), '<div class="an3WzG_chat"></div>')
  check('content column @280 rejected (right of centre)', isSidebar(content) === false)

  const small = node('_5Qcc8a_root', box(260, 50, 10), '<div class="_5Qcc8a_panelList"></div>')
  check('short element rejected (height < 200)', isSidebar(small) === false)

  const huge = node('V4vHZW_root', box(737, 29171, 280), '<div class="V4vHZW_panelList"></div>')
  check('scrolled content column rejected (left > half)', isSidebar(huge) === false)
}

console.log('3) a _root column WITHOUT the sidebar children is rejected')
{
  const impostor = node('GAkraW_root', box(272, 1644, 8), '<div class="GAkraW_body"></div>')
  check('no sidebar child markers → rejected', isSidebar(impostor) === false)
}

console.log('4) collapsed rail still matches (narrow, but tall and on the left)')
{
  const rail = node('wtg9ga_root wtg9ga_collapsed', box(56, 2096, 0), '<div class="wtg9ga_newSession"></div>')
  check('56px rail matches', isSidebar(rail) === true)
}

console.log('5) unknown geometry parks the handle on screen, never at -11px')
{
  // Mirror place()'s fallback.
  const place = (col) => {
    const b = col ? col.getBoundingClientRect() : null
    const edge = b ? b.right : 56
    return Math.round(edge - 11)
  }
  check('no column → 45px (visible)', place(null) === 45)
  check('real column → 269px', place(node('wtg9ga_root', box(280, 2096, 0))) === 269)
  check('collapsed rail → 45px', place(node('wtg9ga_root', box(56, 2096, 0))) === 45)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
