export const meta = {
  name: 'ultra-mode',
  description:
    'Run a disciplined multi-agent deep-work loop: plan, parallel attack, adversarial review, then synthesize.',
  whenToUse:
    'Large, ambiguous coding, review, design, or research tasks where one pass is likely to miss tradeoffs. Pass a bare task string, or {task, intensity?, lanes?, reviewers?, constraints?, context?, finalFormat?}.',
  phases: [{ title: 'Plan' }, { title: 'Attack' }, { title: 'Review' }, { title: 'Synthesize' }],
}

const PLAN = {
  type: 'object',
  properties: {
    objective: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    workstreams: {
      type: 'array',
      minItems: 2,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          prompt: { type: 'string' },
          success: { type: 'string' },
        },
        required: ['name', 'prompt'],
      },
    },
    acceptance: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['objective', 'workstreams'],
}

const ATTEMPT = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    recommendation: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'recommendation'],
}

const REVIEW = {
  type: 'object',
  properties: {
    verdict: { enum: ['pass', 'revise', 'reject'] },
    strongest: { type: 'array', items: { type: 'string' } },
    weakSpots: { type: 'array', items: { type: 'string' } },
    missingChecks: { type: 'array', items: { type: 'string' } },
    mustFix: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'weakSpots', 'mustFix'],
}

const FINAL = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    decision: { type: 'string' },
    actionPlan: { type: 'array', items: { type: 'string' } },
    verification: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['answer', 'decision', 'actionPlan'],
}

const input = typeof args === 'string' ? { task: args } : args && typeof args === 'object' ? args : {}
const task = input.task || input.request || input.question || 'Solve the task carefully.'
const intensity = ['lite', 'standard', 'max'].includes(input.intensity) ? input.intensity : 'standard'
const laneCap = Math.max(
  2,
  Math.min(8, Number(input.lanes) || (intensity === 'lite' ? 3 : intensity === 'max' ? 6 : 4)),
)
const reviewerCount = Math.max(
  1,
  Math.min(6, Number(input.reviewers) || (intensity === 'lite' ? 2 : intensity === 'max' ? 4 : 3)),
)
const finalFormat =
  input.finalFormat ||
  'A concise Markdown-ready result that a host Codex agent can act on after local verification.'
const constraints = toList(input.constraints)
const context = toList(input.context)
const userStrategies = Array.isArray(input.strategies) ? input.strategies.filter(Boolean) : []

const defaultStreams = [
  {
    name: 'architect',
    prompt:
      'Find the cleanest overall approach. Focus on decomposition, interfaces, invariants, and tradeoffs.',
  },
  {
    name: 'implementer',
    prompt:
      'Make the task actionable. Focus on concrete edits, commands, edge cases, and a minimal working path.',
  },
  {
    name: 'skeptic',
    prompt:
      'Try to break likely answers. Focus on hidden assumptions, failure modes, missing tests, and false positives.',
  },
  {
    name: 'maintainer',
    prompt:
      'Optimize for long-term maintainability. Focus on simplicity, consistency with the existing project, and rollback risk.',
  },
  {
    name: 'tester',
    prompt:
      'Design the verification path. Focus on tests, manual checks, fixtures, observability, and confidence signals.',
  },
  {
    name: 'product',
    prompt:
      'Evaluate the user-facing outcome. Focus on whether the answer solves the real request without overbuilding.',
  },
]

phase('Plan')
log(`ultra-mode ${intensity}: planning ${laneCap} lane(s), ${reviewerCount} reviewer(s)`)
const plan = await agent(
  `Plan an ultra-mode ODW run for the task below. Create independent workstreams; do not solve the task yet.\n\n` +
    `Task:\n${task}\n\n` +
    `Constraints:\n${constraints.join('\n') || '(none)'}\n\n` +
    `Context:\n${context.join('\n') || '(none)'}\n\n` +
    `Return workstreams that are meaningfully different, not duplicate personas.`,
  { label: 'planner', phase: 'Plan', schema: PLAN }
)

const plannedStreams = (plan.workstreams || [])
  .filter((stream) => stream && stream.prompt)
  .map((stream, i) => ({
    name: stream.name || `planned-${i + 1}`,
    prompt: stream.prompt,
    success: stream.success || '',
  }))
const streams = normalizeStreams(userStrategies).concat(plannedStreams, defaultStreams).slice(0, laneCap)

phase('Attack')
log(`${streams.length} lanes attacking independently`)
const attempts = await parallel(
  streams.map((stream, i) => () =>
    agent(
      `You are the ${stream.name} lane in an ultra-mode run. Work independently; do not assume other lanes exist.\n\n` +
        `Task:\n${task}\n\n` +
        `Lane instruction:\n${stream.prompt}\n\n` +
        `Success signal:\n${stream.success || '(infer from the task)'}\n\n` +
        `Constraints:\n${constraints.join('\n') || '(none)'}\n\n` +
        `Context:\n${context.join('\n') || '(none)'}\n\n` +
        `Return a concrete, evidence-aware result. If this is a coding task, return the recommended edits and checks rather than claiming to have changed the real workspace.`,
      { label: `lane-${i + 1}-${slug(stream.name)}`, phase: 'Attack', schema: ATTEMPT }
    ).then((report) => ({ lane: stream.name, report }))
  )
)

const successfulAttempts = attempts.filter(Boolean)
if (successfulAttempts.length === 0) {
  return { task, intensity, error: 'no_lanes_succeeded', plan }
}

phase('Review')
log(`${reviewerCount} reviewers challenging ${successfulAttempts.length} lane result(s)`)
const attemptDigest = JSON.stringify(successfulAttempts, null, 2)
const reviews = await parallel(
  Array.from({ length: reviewerCount }, (_, i) => () =>
    agent(
      `You are reviewer #${i + 1} in an ultra-mode run. Challenge the lane outputs below.\n\n` +
        `Task:\n${task}\n\n` +
        `Plan:\n${JSON.stringify(plan, null, 2)}\n\n` +
        `Lane outputs:\n${attemptDigest}\n\n` +
        `Find contradictions, weak assumptions, missing checks, and must-fix issues. Default to revise/reject when evidence is thin.`,
      { label: `review-${i + 1}`, phase: 'Review', schema: REVIEW }
    )
  )
)

phase('Synthesize')
const validReviews = reviews.filter(Boolean)
const final = await agent(
  `Synthesize the final ultra-mode result. Keep it useful to a host Codex agent that will still verify locally before acting.\n\n` +
    `Required output style:\n${finalFormat}\n\n` +
    `Task:\n${task}\n\n` +
    `Plan:\n${JSON.stringify(plan, null, 2)}\n\n` +
    `Lane outputs:\n${attemptDigest}\n\n` +
    `Reviews:\n${JSON.stringify(validReviews, null, 2)}\n\n` +
    `Resolve disagreements. Include concrete next actions and verification steps. Do not hide uncertainty.`,
  { label: 'synthesizer', phase: 'Synthesize', schema: FINAL }
)

return {
  task,
  intensity,
  plan,
  lanes: successfulAttempts,
  reviews: validReviews,
  final,
}

function toList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (value === undefined || value === null || value === '') return []
  return [String(value)]
}

function normalizeStreams(values) {
  return values.map((value, i) => {
    if (typeof value === 'string') return { name: `custom-${i + 1}`, prompt: value, success: '' }
    return {
      name: value.name || `custom-${i + 1}`,
      prompt: value.prompt || value.instruction || String(value),
      success: value.success || '',
    }
  })
}

function slug(value) {
  return String(value || 'lane')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
}
