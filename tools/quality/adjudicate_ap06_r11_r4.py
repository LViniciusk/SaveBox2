"""Offline R11-R4 adjudication; no experimental initializer or measurement calls."""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from types import SimpleNamespace

from ap06_authorities import (checked_path, private_permissions, relative_path, sha256,
    validate_owned_destination, verify_files, verify_publication, publish_snapshot)
import run_ap06_r11 as r11

ROOT=Path(__file__).resolve().parents[2]
IDENTITY='f75cb11d01f6766c611e546ca2d527975df03070bffaca225bea494cdfba88f4'
IMPLEMENTATION='fc2c11bfce6773afecefbe451b29cce5b53ea444'
REFERENCE='3410414a9ea48e2fb64e0e882b24da7f8fc25f6d'
FREEZE_SHA='47bbf25ad48a8c72b6e0041d5d399f26b6dbfa89f2a6510c19fbf6a6235af771'
DELIVERY_SHA='c5263d0a6ceeacb64aaae4a4423f822e342bc40cdf1a2632fc65ac6caade6dc4'
FROZEN_FILES=569
SOURCE='r11-r3/tooling/source/'
R3_OUTPUT='.quality/readiness-wave11-r3/'
SCHEDULE=tuple(('triage',c) for c in r11.CONDITIONS)+tuple(('formal',c) for c in ('r11.0','r11.2','r11.2','r11.0','r11.0','r11.2'))
BRIDGE_FUNCTIONS={'classify','formal_scalars','validate_classifier_result','invoke_classifier'}


def require(condition,reason):
    if not condition:raise ValueError(reason)


def read(path):
    return json.loads(checked_path(path).read_text(encoding='utf-8-sig'))


def r3_snapshot(root):
    paths=[*(root/'r11-r3').rglob('*'),*(root/'manifests').glob('r11-r3-*.json')]
    return {p.relative_to(root).as_posix():sha256(checked_path(p)) for p in paths if p.is_file()}


def snapshot_digest(snapshot):
    return hashlib.sha256(json.dumps(snapshot,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def verify_private_acl(root):
    if os.name!='nt':
        private_permissions(root);return {'status':'PASS','scope':'Owned private authority root'}
    script='''$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    $items=@(Get-Item -LiteralPath $env:AP06_R4_AUTHORITY -Force)+@(Get-ChildItem -LiteralPath $env:AP06_R4_AUTHORITY -Recurse -Force);
    foreach($item in $items) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'REPARSE_POINT'};
      $acl=Get-Acl -LiteralPath $item.FullName;
      if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {throw 'OWNER_CHANGED'};
      foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value) {throw 'ACL_SHARED'};
      }
    }
    @{status='PASS';paths=$items.Count;owner='CurrentUser';exclusiveAccess=$true;reparsePoints=0}|ConvertTo-Json -Compress'''
    result=subprocess.run(['powershell','-NoProfile','-NonInteractive','-Command',script],
        env=dict(os.environ,AP06_R4_AUTHORITY=str(root)),capture_output=True,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
    require(result.returncode==0,'R11_R4_ACL_INVALID')
    receipt=json.loads(result.stdout);require(receipt.get('status')=='PASS','R11_R4_ACL_INVALID')
    return receipt


def verify_validator_equivalence(root,freeze):
    name='tools/quality/run_ap06_r11.py'
    def normalized(path):
        tree=ast.parse(path.read_text(encoding='utf-8-sig'))
        tree.body=[n for n in tree.body if not isinstance(n,ast.FunctionDef) or n.name not in BRIDGE_FUNCTIONS]
        return ast.dump(tree,include_attributes=False)
    original=normalized(root/SOURCE/name);current=normalized(ROOT/name)
    require(original==current,'R11_R4_VALIDATOR_CHANGED')
    dependencies=[]
    for path,digest in freeze['files'].items():
        if path.startswith('tools/quality/') and path.endswith('.py') and not Path(path).name.startswith('test') and path!=name:
            require(sha256(ROOT/path)==digest,'R11_R4_VALIDATOR_DEPENDENCY_CHANGED');dependencies.append(path)
    contract='frontend/tools/ap06-r11-contract.mjs'
    require(sha256(ROOT/contract)==freeze['files'][contract],'R11_R4_CLASSIFIER_CHANGED')
    return {'status':'EQUIVALENT','method':'AST identical outside the four bridge functions; validator dependencies byte-identical',
        'normalizedAstSha256':hashlib.sha256(original.encode()).hexdigest(),'dependencies':dependencies,
        'originalModuleSha256':freeze['files'][name],'currentModuleSha256':sha256(ROOT/name),
        'originalClassifierSha256':freeze['files'][contract]}


def verify_inputs(root,identity):
    require(identity==IDENTITY,'R11_R4_AUTHORITY_IDENTITY_CHANGED')
    validate_owned_destination(root,identity,campaign='AP-06-R10')
    require(sha256(checked_path(root/'manifests/r11-r3-delivery.json'))==DELIVERY_SHA,'R11_R4_DELIVERY_CHANGED')
    verify_publication(root,identity,'r11-r3-delivery')
    acl=verify_private_acl(root)
    publications={}
    def publication(name,expected=None):
        path=checked_path(root/'manifests'/relative_path(name+'.json'))
        digest=sha256(path)
        if expected is not None:require(digest==expected,'R11_R4_MANIFEST_CHANGED')
        manifest=read(path)
        require(manifest.get('campaign')=='AP-06-R10','R11_R4_MANIFEST_CAMPAIGN_CHANGED')
        verify_files(root,manifest);publications[name]=digest
        return manifest
    def evidence(name,path,expected=None):
        manifest=publication(name,expected)
        require(any(row['path']==path for row in manifest['files']),'R11_R4_ARTIFACT_NOT_PUBLISHED')
        return read(root/relative_path(path))
    seal=evidence('r11-r3-delivery','r11-r3/evidence/delivery-seal.json',DELIVERY_SHA)
    require(seal['implementationHead']==IMPLEMENTATION and seal['evidenceHead']==REFERENCE,'R11_R4_DELIVERY_HEAD_CHANGED')
    publication('r11-r3-reports',seal['reportsManifestSha256'])
    report_path=root/'r11-r3/evidence/reports/ap06-r11-r3.json'
    require(sha256(report_path)==seal['jsonSha256'],'R11_R4_REPORT_CHANGED')
    report=read(report_path)
    require(report['status']==seal['status']=='R11_INCONCLUSIVE' and report['implementationHead']==IMPLEMENTATION,'R11_R4_HISTORICAL_STATUS_CHANGED')
    published=report['privatePublications']
    # Bind the post-freeze manifests through the original report and delivery seal.
    def bound(name,path):return evidence(name,path,published[name])
    bound('r11-r3-freeze','r11-r3/freeze/freeze.json')
    freeze_path=root/'r11-r3/freeze/freeze.json'
    require(sha256(freeze_path)==FREEZE_SHA,'R11_R4_FREEZE_CHANGED')
    freeze=read(freeze_path)
    require(freeze['campaign']=='AP-06-R11-R3' and freeze['implementationHead']==IMPLEMENTATION,'R11_R4_FROZEN_HEAD_CHANGED')
    require(len(freeze['files'])==FROZEN_FILES,'R11_R4_FROZEN_FILE_SET_CHANGED')
    for name,digest in freeze['publicationHashes'].items():publication(name,digest)
    for path,digest in freeze['files'].items():
        require(sha256(checked_path(root/relative_path(SOURCE+path)))==digest,'R11_R4_FROZEN_SOURCE_CHANGED')
    equivalence=verify_validator_equivalence(root,freeze)
    versions=read(root/SOURCE/R3_OUTPUT/'baseline/versions.json')
    node=versions['nodeExecutable']
    require(Path(node).is_absolute() and sha256(node)==versions['nodeSha256'],'R11_R4_NODE_CHANGED')
    unit=read(root/SOURCE/R3_OUTPUT/'tooling/angular-unit-1.json')
    require(unit['status']=='PASS' and unit['unitBrowserLaunches']==unit['unitBrowserLaunchAttempts']==1 and unit['browserClosed'] is True and unit['processExitAudit']['status']=='PASS','R11_R4_PREFLIGHT_BUDGET_CHANGED')
    reservation=bound('r11-r3-development-reserved','r11-r3/evidence/development-reservation.json')
    require(reservation=={'campaign':'AP-06-R11-R3','implementationHead':IMPLEMENTATION,'developmentMaximum':1,'measurementMaximum':10,'retries':0},'R11_R4_RESERVATION_CHANGED')
    ledger=bound('r11-r3-ledger-finished-10','r11-r3/evidence/ledger-finished-10.json')
    require(len(ledger)==10 and [(r['stage'],r['condition']) for r in ledger]==list(SCHEDULE),'R11_R4_ATTEMPT_ORDER_CHANGED')
    require(all(all(type(r[k]) is int and r[k]==1 for k in ('browserLaunches','launchAttempts','reservedAttempts')) for r in ledger),'R11_R4_MEASUREMENT_BUDGET_CHANGED')
    budget=seal['budget']
    require(all(budget[k]==v for k,v in {'developmentUsed':1,'measurementUsed':10,'launchAttempts':11,'retries':0,'totalUsed':11}.items()),'R11_R4_BUDGET_CHANGED')
    stop=bound('r11-r3-stop-campaign','r11-r3/evidence/STOP-campaign.json')
    require(stop==report['executionStop']==seal['stop'] and stop['reason']=='R11_VALIDATION_CONTRACT_FAILED' and stop['retries']==0,'R11_R4_HISTORICAL_STOP_CHANGED')
    candidate=bound('r11-r3-triage-decision','r11-r3/evidence/triage-decision.json')
    fixtures=read(root/SOURCE/R3_OUTPUT/'fixtures/manifest.json')
    require(sha256(root/SOURCE/R3_OUTPUT/'fixtures/manifest.json')==freeze['fixtureHash'],'R11_R4_CORPUS_CHANGED')
    require(len(report['measurements'])==10 and len({r['rawSha256'] for r in ledger})==10,'R11_R4_RAW_SET_CHANGED')
    rows=[]
    for index,((stage,condition),entry,pub) in enumerate(zip(SCHEDULE,ledger,report['measurements']),1):
        attempt=f'{index:02}-{condition}';path=f'r11-r3/evidence/{stage}/{attempt}/complete.raw.json'
        raw=bound(f'r11-r3-{stage}-{attempt}-complete',path)
        digest=sha256(root/path)
        require(pub['rawAuthorityPath']==path and pub['rawSha256']==entry['rawSha256']==digest and (pub['stage'],pub['condition'])==(stage,condition),'R11_R4_RAW_IDENTITY_CHANGED')
        require(raw['runs'][0]['runId']==f'{stage}-{attempt}','R11_R4_RAW_ORDER_CHANGED')
        classification=r11.validate_condition(raw,condition,stage,freeze,fixtures)
        historical=bound(f'r11-r3-{stage}-{attempt}-decision',path.replace('complete.raw.json','decision.json'))
        require(historical['rawSha256']==digest and historical['classification']==pub['classification']==classification and
            (historical['stage'],historical['condition'])==(stage,condition),'R11_R4_INDIVIDUAL_CLASSIFICATION_CHANGED')
        delta=r11.renderer_delta(raw)
        require(type(pub['samples'][6]['privateDeltaMiB']['renderer']) in (int,float) and pub['samples'][6]['privateDeltaMiB']['renderer']==delta,'R11_R4_PUBLISHED_DELTA_CHANGED')
        rows.append({'attempt':index,'stage':stage,'condition':condition,'rawPath':path,'rawSha256':digest,
            'individualValidation':classification,'rendererPrivateDeltaMiB':delta,'originalSampleCount':len(raw['runs'][0]['samples'])})
    return {'freezeSha256':FREEZE_SHA,'implementationHead':IMPLEMENTATION,'evidenceHead':REFERENCE,'frozenFiles':FROZEN_FILES,
        'validatorEquivalence':equivalence,'acl':acl,'publications':publications,'rows':rows,'recordedCandidate':candidate,
        'historicalStop':stop,'historicalStopSha256':sha256(root/'r11-r3/evidence/STOP-campaign.json'),
        'historicalBudget':budget,'nodeExecutable':node,'nodeSha256':versions['nodeSha256']}


def adjudicate(root,identity):
    inputs=verify_inputs(root,identity)
    before=r3_snapshot(root)
    values={r['condition']:r['rendererPrivateDeltaMiB'] for r in inputs['rows'] if r['stage']=='triage'}
    wave=SimpleNamespace(root=ROOT,node=inputs['nodeExecutable'])
    candidate=r11.classify(wave,values)
    require(candidate==inputs['recordedCandidate'],'R11_R4_CANDIDATE_CHANGED')
    formal=r11.formal_scalars([r for r in inputs['rows'] if r['stage']=='formal'])
    a,b=candidate['pair']
    require([r['condition'] for r in formal]==[a,b,b,a,a,b],'R11_R4_FORMAL_ORDER_CHANGED')
    decision=r11.classify(wave,values,formal,candidate)
    after=r3_snapshot(root)
    require(after==before,'R11_R4_HISTORICAL_EVIDENCE_CHANGED')
    return {'campaign':'AP-06-R11-R4','status':'R11_R4_ADJUDICATION_CONFIRMED' if decision['status']=='R11_ATTRIBUTION_CONFIRMED' else 'R11_R4_INCONCLUSIVE',
        'hypothesis':decision.get('hypothesis'),'pair':decision.get('pair'),'triage':candidate,'formal':decision,'inputs':inputs,
        'r3Preservation':{'status':'PASS','files':len(before),'beforeSha256':snapshot_digest(before),'afterSha256':snapshot_digest(after)},
        'chromiumUsed':0,'newMeasurements':0,'retries':0,'historicalR3Status':'R11_INCONCLUSIVE','ap06':'OPEN'}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True);parser.add_argument('--identity',required=True)
    args=parser.parse_args();out=ROOT/'.quality/readiness-wave11-r4';output_ready=False
    try:
        checked_path(out);created=not out.exists();out.mkdir(parents=True,exist_ok=True)
        private_permissions(out,create=created)
        for name in ('baseline','pipeline','final'):checked_path(out/name).mkdir(exist_ok=True)
        output_ready=True
        require(not (out/'final/adjudication.json').exists(),'R11_R4_ALREADY_ADJUDICATED')
        def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True).strip()
        require(not git('status','--porcelain'),'R11_R4_COMMITTED_IMPLEMENTATION_REQUIRED')
        head=git('rev-parse','HEAD')
        code_paths=('tools/quality/adjudicate_ap06_r11_r4.py','tools/quality/run_ap06_r11.py',
            'frontend/tools/ap06-r11-classifier.mjs','frontend/tools/ap06-r11-contract.mjs')
        code={p:sha256(ROOT/p) for p in code_paths}
        result=adjudicate(args.root,args.identity)
        require(code=={p:sha256(ROOT/p) for p in code_paths} and git('rev-parse','HEAD')==head and not git('status','--porcelain'),'R11_R4_IMPLEMENTATION_CHANGED')
        result.update(adjudicatorHead=head,implementationFiles=code,
            adjudicatorSha256=sha256(Path(__file__)),bridgeSha256=sha256(ROOT/'tools/quality/run_ap06_r11.py'),
            nodeBridgeSha256=sha256(ROOT/'frontend/tools/ap06-r11-classifier.mjs'))
        target=out/'final/adjudication.json';target.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
        receipt=publish_snapshot(args.root,args.identity,'r11-r4-adjudication',{'r11-r4/evidence/adjudication.json':target},out/'pipeline')
        (out/'final/publication.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
        print(json.dumps({k:result[k] for k in ('status','hypothesis','chromiumUsed','newMeasurements','retries')}))
        return 0
    except (ValueError,OSError,RuntimeError,KeyError,IndexError,TypeError,subprocess.SubprocessError) as error:
        reason=str(error) if re.fullmatch(r'[A-Z][A-Z0-9_:]+',str(error)) else 'R11_R4_REQUIRED_ARTIFACT_MISSING' if isinstance(error,FileNotFoundError) else 'R11_R4_INPUT_OR_EXECUTION_FAILED'
        stop={'campaign':'AP-06-R11-R4','status':'R11_R4_BLOCKED','reason':reason,'chromiumUsed':0,'newMeasurements':0,'retries':0}
        if output_ready:(out/'final/STOP.json').write_text(json.dumps(stop,indent=2)+'\n',encoding='utf-8')
        print(json.dumps(stop));return 1


if __name__=='__main__':raise SystemExit(main())
