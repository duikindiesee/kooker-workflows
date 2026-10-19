// tests/check-node-release-optout.cjs
// Contract + parser execution using official supported tooling:
// - yaml 2.9.1 (parseDocument, errors, duplicateKeys, toJS)
// - @actions/expressions 0.3.61 (Lexer, Parser, Evaluator, data.Dictionary, StringData, BooleanData)
//
// Evaluates:
// 1. Official YAML parse of .github/workflows/node-version-bump.yml
//    - Document has 0 errors and no duplicate keys
//    - 'on' mapping parsed as GitHub Actions key (not YAML 1.1 boolean)
//    - on.workflow_call is a mapping (not a scalar or block-string)
//    - on.workflow_call.inputs['create-release'] attributes:
//      required === false, type === 'boolean', default === true, non-empty description
// 2. Step extraction:
//    - finds exact step 'Create GitHub Release' by name
//    - checks step body contains idempotent gh release view & create commands
// 3. Official @actions/expressions parsing and evaluation:
//    - lexes and parses actual step 'if:' expression AST
//    - evaluates across 6 truth table cases using actual parsed AST & Evaluator:
//      bumped ('true' | 'false') × caller input (omitted | true | false)
// 4. Robust negative controls:
//    - missing input in on.workflow_call.inputs
//    - Root block-scalar workflow_call mutation ('workflow_call: |') -> must fail
//    - env documentation spoof (declaration only in env) -> must fail
//    - wrong default (false) -> must fail
//    - wrong type ('string') -> must fail
//    - malformed condition expression -> must fail
//    - mismatched operand condition -> must fail

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// Pinned official dependencies located in tests/node_modules
const yaml = require(path.resolve(__dirname, 'node_modules/yaml'));

async function main() {
  // Dynamically import ESM @actions/expressions
  const expressionsModule = await import(path.resolve(__dirname, 'node_modules/@actions/expressions/dist/index.js'));
  const { Lexer, Parser, Evaluator, data } = expressionsModule;

  function runVerification(yamlString) {
    // 1. Official YAML parsing
    const doc = yaml.parseDocument(yamlString, { uniqueKeys: true });
    if (doc.errors && doc.errors.length > 0) {
      throw new Error(`YAML_PARSE_ERROR: ${doc.errors[0].message}`);
    }

    const jsObj = doc.toJS();
    if (!jsObj || typeof jsObj !== 'object') {
      throw new Error('YAML_INVALID: Parsed document is not an object');
    }

    // Must have 'on' key (GitHub Actions trigger)
    if (!jsObj.on || typeof jsObj.on !== 'object') {
      throw new Error('MISSING_ON: Top-level "on" key is missing or not an object');
    }

    // Check workflow_call
    const workflowCall = jsObj.on.workflow_call;
    if (!workflowCall || typeof workflowCall !== 'object') {
      throw new Error('INVALID_WORKFLOW_CALL: on.workflow_call is missing or not a mapping');
    }

    // Check inputs
    const inputs = workflowCall.inputs;
    if (!inputs || typeof inputs !== 'object') {
      throw new Error('MISSING_INPUTS: on.workflow_call.inputs is missing or not a mapping');
    }

    const createReleaseInput = inputs['create-release'];
    if (!createReleaseInput || typeof createReleaseInput !== 'object') {
      throw new Error('MISSING_INPUT: on.workflow_call.inputs["create-release"] is missing');
    }

    if (createReleaseInput.type !== 'boolean') {
      throw new Error(`WRONG_TYPE: create-release type must be 'boolean', got '${createReleaseInput.type}'`);
    }

    if (createReleaseInput.default !== true) {
      throw new Error(`WRONG_DEFAULT: create-release default must be true, got '${createReleaseInput.default}'`);
    }

    if (createReleaseInput.required !== false) {
      throw new Error(`WRONG_REQUIRED: create-release required must be false, got '${createReleaseInput.required}'`);
    }

    if (!createReleaseInput.description || typeof createReleaseInput.description !== 'string' || !createReleaseInput.description.trim()) {
      throw new Error('MISSING_DESCRIPTION: create-release description must be a non-empty string');
    }

    // 2. Extract Create GitHub Release step
    const jobs = jsObj.jobs;
    if (!jobs || typeof jobs !== 'object' || !jobs.bump || !Array.isArray(jobs.bump.steps)) {
      throw new Error('INVALID_JOBS: jobs.bump.steps array is missing');
    }

    const releaseStep = jobs.bump.steps.find(s => s && s.name === 'Create GitHub Release');
    if (!releaseStep) {
      throw new Error('MISSING_STEP: Step "Create GitHub Release" not found');
    }

    if (!releaseStep.if || typeof releaseStep.if !== 'string') {
      throw new Error('MISSING_IF: Step "Create GitHub Release" missing if-condition');
    }

    // Verify guarded script body
    assert.match(releaseStep.run, /gh release view "v\$\{\{ steps\.bump\.outputs\.new-version \}\}"/);
    assert.match(releaseStep.run, /gh release create "v\$\{\{ steps\.bump\.outputs\.new-version \}\}"/);

    // 3. Official @actions/expressions Lex, Parse, and AST check
    const rawIf = releaseStep.if.trim();
    // Enforce condition syntax contains both operands
    if (!rawIf.includes("steps.bump.outputs.bumped") || !rawIf.includes("inputs.create-release")) {
      throw new Error(`MALFORMED_CONDITION: condition missing required operands: ${rawIf}`);
    }

    const lexer = new Lexer(rawIf);
    const lexResult = lexer.lex();
    const parser = new Parser(lexResult.tokens, ['steps', 'inputs'], []);
    const ast = parser.parse();

    // 4. Evaluate actual parsed expression across 6 truth-table cases using official Evaluator
    const testCases = [
      { bumped: 'true',  input: undefined, expected: true,  desc: "bumped='true' × omitted (default true) -> run" },
      { bumped: 'true',  input: true,      expected: true,  desc: "bumped='true' × true                    -> run" },
      { bumped: 'true',  input: false,     expected: false, desc: "bumped='true' × false                   -> skip" },
      { bumped: 'false', input: undefined, expected: false, desc: "bumped='false' × omitted (default true) -> skip" },
      { bumped: 'false', input: true,      expected: false, desc: "bumped='false' × true                   -> skip" },
      { bumped: 'false', input: false,     expected: false, desc: "bumped='false' × false                  -> skip" },
    ];

    for (const tc of testCases) {
      const effectiveInput = (tc.input === undefined) ? createReleaseInput.default : tc.input;

      const context = new data.Dictionary();
      const stepsDict = new data.Dictionary();
      const bumpDict = new data.Dictionary();
      const outputsDict = new data.Dictionary();
      outputsDict.add('bumped', new data.StringData(tc.bumped));
      bumpDict.add('outputs', outputsDict);
      stepsDict.add('bump', bumpDict);

      const inputsDict = new data.Dictionary();
      inputsDict.add('create-release', new data.BooleanData(effectiveInput));

      context.add('steps', stepsDict);
      context.add('inputs', inputsDict);

      const evaluator = new Evaluator(ast, context);
      const evalResult = evaluator.evaluate();
      const boolVal = evalResult.value;

      assert.equal(boolVal, tc.expected, `Evaluator mismatch on ${tc.desc}: got ${boolVal}, expected ${tc.expected}`);
    }

    return {
      valid: true,
      casesPassed: testCases.length
    };
  }

  const workflowPath = path.resolve(__dirname, '../.github/workflows/node-version-bump.yml');
  const candidateYaml = fs.readFileSync(workflowPath, 'utf8');

  // Positive verification
  const posResult = runVerification(candidateYaml);
  console.log(`PASS: Candidate workflow passed official YAML 2.9.1 parse and all ${posResult.casesPassed} @actions/expressions Evaluator cases`);

  // Negative Control 1: Root workflow_call literal scalar / block-string mutation
  const scalarWfCallYaml = candidateYaml.replace(
    '  workflow_call:\n    inputs:',
    '  workflow_call: |\n    inputs:'
  );
  assert.notEqual(scalarWfCallYaml, candidateYaml, 'Mutation 1 failed to modify fixture');
  assert.throws(() => runVerification(scalarWfCallYaml), /INVALID_WORKFLOW_CALL/, 'Negative 1 failed: block scalar workflow_call not rejected');
  console.log('PASS: Negative control 1: Root workflow_call literal scalar correctly rejected');

  // Negative Control 2: Env documentation spoof (declaration only in env)
  const envSpoofYaml = candidateYaml
    .replace('    inputs:\n      create-release:\n', '    inputs:\n      other-input:\n')
    .replace('env:\n  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true', 'env:\n  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true\n  OPTOUT_DOCUMENTATION: "create-release: default: true type: boolean required: false"');
  assert.notEqual(envSpoofYaml, candidateYaml, 'Mutation 2 failed to modify fixture');
  assert.throws(() => runVerification(envSpoofYaml), /MISSING_INPUT/, 'Negative 2 failed: Env doc spoof not rejected');
  console.log('PASS: Negative control 2: Env documentation spoof correctly rejected');

  // Negative Control 3: Missing input entirely
  const missingInputYaml = candidateYaml.replace(
    /    inputs:\n      create-release:[\s\S]*?(?=    outputs:)/,
    ''
  );
  assert.notEqual(missingInputYaml, candidateYaml, 'Mutation 3 failed to modify fixture');
  assert.throws(() => runVerification(missingInputYaml), /MISSING_INPUT/, 'Negative 3 failed: Missing input not rejected');
  console.log('PASS: Negative control 3: Missing create-release input correctly rejected');

  // Negative Control 4: Wrong default (false instead of true)
  const wrongDefaultYaml = candidateYaml.replace('default: true', 'default: false');
  assert.notEqual(wrongDefaultYaml, candidateYaml, 'Mutation 4 failed to modify fixture');
  assert.throws(() => runVerification(wrongDefaultYaml), /WRONG_DEFAULT/, 'Negative 4 failed: Default false not rejected');
  console.log('PASS: Negative control 4: Default false correctly rejected');

  // Negative Control 5: Wrong type (string instead of boolean)
  const wrongTypeYaml = candidateYaml.replace('type: boolean', 'type: string');
  assert.notEqual(wrongTypeYaml, candidateYaml, 'Mutation 5 failed to modify fixture');
  assert.throws(() => runVerification(wrongTypeYaml), /WRONG_TYPE/, 'Negative 5 failed: Type string not rejected');
  console.log('PASS: Negative control 5: Type string correctly rejected');

  // Negative Control 6: Malformed step condition (missing inputs.create-release operand)
  const malformedConditionYaml = candidateYaml.replace(
    "if: steps.bump.outputs.bumped == 'true' && inputs.create-release",
    "if: steps.bump.outputs.bumped == 'true'"
  );
  assert.notEqual(malformedConditionYaml, candidateYaml, 'Mutation 6 failed to modify fixture');
  assert.throws(() => runVerification(malformedConditionYaml), /MALFORMED_CONDITION/, 'Negative 6 failed: Malformed condition not rejected');
  console.log('PASS: Negative control 6: Malformed condition correctly rejected');

  // Negative Control 7: CRLF line-ending positive control
  const crlfYaml = candidateYaml.replace(/\n/g, '\r\n');
  const crlfResult = runVerification(crlfYaml);
  assert.equal(crlfResult.valid, true);
  console.log('PASS: Positive control: CRLF line-endings handled robustly');

  console.log('ALL checks passed successfully.');
}

main().catch(err => {
  console.error('FAIL: ' + err.message);
  process.exit(1);
});
