// Contract + mocked execution of the actual merge-arm shell; no GitHub calls.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
const text=fs.readFileSync('.github/workflows/node-version-bump.yml','utf8').replaceAll('\r\n','\n');
const block=(name)=>{const start=text.indexOf('      - name: '+name+'\n');assert(start>=0);const end=text.indexOf('\n      - name:',start+1);return text.slice(start,end<0?undefined:end);};
const arm=block('Enable auto-merge on bump PR');
assert.match(arm,/GH_TOKEN: \$\{\{ secrets\.MAVEN_PUBLISH_TOKEN \}\}/,'merge initiation must use existing non-GITHUB_TOKEN author identity');
assert.match(block('Create version-bump pull request'),/token: \$\{\{ secrets\.MAVEN_PUBLISH_TOKEN \}\}/);
assert.match(block('Approve bump PR (separate approver identity)'),/GH_TOKEN: \$\{\{ secrets\.GITOPS_APPROVER_TOKEN \}\}/);
assert.match(text,/abort_bump_commit/);assert.match(text,/COMMITTED_PATHS/);
const script=arm.split('        run: |\n')[1].split('        env:')[0].split('\n').map(l=>l.startsWith('          ')?l.slice(10):l).join('\n').replaceAll('${{ steps.create-pr.outputs.pull-request-number }}','123');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'node-merge-contract-'));
try {
 for(const [mode,expected] of [['success',0],['unprotected',0],['unexpected',1]]){
  const calls=path.join(tmp,mode+'.txt').replaceAll('\\','/');
  const prelude='gh() { printf "%s\\n" "$*" >> "$CALLS"; case "$MODE" in success) return 0;; unprotected) printf "Protected branch rules not configured\\n"; return 1;; *) printf "synthetic API refusal\\n"; return 1;; esac; }\n';
  const p=spawnSync('bash',['-c',prelude+script],{encoding:'utf8',env:{...process.env,GH_TOKEN:'synthetic-only',GITHUB_REPOSITORY:'fixture/consumer',CALLS:calls,MODE:mode}});
  assert.equal(p.status,expected,p.stderr);assert.match(fs.readFileSync(calls,'utf8'),/^pr merge 123 --auto --squash --repo fixture\/consumer\n$/);
  console.log('PASS actual merge-arm mock',mode);
 }
 console.log('PASS token-role and final-package-guard contract');
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
