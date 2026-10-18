"""Materialize a fresh R11 authority from verified historical corpus bytes, without Chromium."""
import argparse
import json
from pathlib import Path
import secrets
import shutil

from ap06_authorities import (checked_path, initialize, private_permissions, publish_authorities,
    publish_snapshot, sha256, verify_publication)
from ap06_key_custody import custody_context, protect, readback, unprotect
from ap06_freeze import NATIVE_FILES, native_source_files, validate_native_build_authority
from run_readiness_wave1 import Wave
from run_ap06_r12_r2 import validate_r8_corpus


def prepare(wave, source, *, round_number=11):
    if round_number not in (11,12):raise ValueError('AP06_PREPARATION_CAMPAIGN_INVALID')
    campaign=f'AP-06-R12-R{round_number}-factorial'
    source=checked_path(Path(source).absolute())
    historical=Wave(source.parents[1]);historical.output=source
    validate_r8_corpus(historical)
    config=json.loads((source/'baseline/authority-config.local.json').read_text())
    origin=Path(config['AP06_AUTHORITY_ROOT']);readback(origin,config['identity'])
    identity=secrets.token_hex(32);destination=wave.output/'authority'
    if destination.exists():raise ValueError(f'R12R{round_number}_AUTHORITY_ALREADY_EXISTS')
    initialize(destination,identity,campaign='AP-06-R10')
    corpus=verify_publication(origin,config['identity'],'corpus-publication')
    publication=publish_authorities(origin,destination,corpus,identity,'corpus-publication')
    stage=wave.output/'pipeline/key-stage';stage.mkdir();private_permissions(stage,create=True)
    previous=json.loads((origin/'keys/custody.json').read_text())
    payload=unprotect((origin/'keys/fdks.dpapi').read_bytes(),previous)
    context=custody_context(identity,sha256(destination/'manifests/corpus.json'))
    (stage/'fdks.dpapi').write_bytes(protect(payload,context));del payload
    (stage/'custody.json').write_text(json.dumps(context),encoding='utf-8')
    publish_snapshot(destination,identity,'custody',{'keys/'+p.name:p for p in stage.iterdir()},wave.output/'pipeline')
    wave.save('baseline/custody-readback.json',readback(destination,identity))
    wave.save('baseline/authority-config.local.json',{'AP06_AUTHORITY_ROOT':str(destination),'identity':identity,
        'privateRuntime':str(wave.output/'pipeline/key-runtime'),'scientificCampaign':campaign})
    manifest=json.loads((source/'fixtures/manifest.json').read_text())
    for row in manifest:
        for kind,name,size,digest in (('plain',row['path'],row['bytes'],row['sha256']),
                ('cipher',f"video-{row['id']}.bin",row['ciphertextBytes'],row['ciphertextSha256'])):
            path=checked_path(source/'fixtures'/kind/name)
            if not path.is_file() or path.stat().st_size!=size or sha256(path)!=digest:raise ValueError(f'R12R{round_number}_CORPUS_CHANGED')
            target=wave.output/'fixtures'/kind/name;target.parent.mkdir(exist_ok=True)
            shutil.copyfile(path,target)
    for name in ('manifest.json',):shutil.copyfile(source/'fixtures'/name,wave.output/'fixtures'/name)
    for name in ('workload.json','corpus-provenance.json'):
        shutil.copyfile(source/'baseline'/name,wave.output/'baseline'/name)
    shutil.copyfile(destination/'tooling/kasumi.cjs',wave.output/'tooling/kasumi.cjs')
    shutil.copyfile(wave.root/'docs/qualidade/ap06-r9-r2.json',wave.output/'baseline/historical-r9.json')
    task=wave.root/f'quality/ap06-r12-r{round_number}.md';shutil.copyfile(task,wave.output/'baseline/task.md')
    wave.save('baseline/task-provenance.json',{'sourceSha256':sha256(task),'sourceBytes':task.stat().st_size})
    protocol=json.loads((source/'baseline/preregistered-protocol.json').read_text())
    protocol.update(campaign=campaign,implementationHead=wave.git('rev-parse','HEAD').strip(),
        authoritySha256=sha256(task),authorityBytes=task.stat().st_size)
    protocol['offlinePreflight']['output']=wave.output.relative_to(wave.root).as_posix()+'/tooling/app'
    if round_number==12:
        protocol['publication']['reports']=['docs/qualidade/ap06-r12-r12.md','docs/qualidade/ap06-r12-r12.json']
        protocol['publication'].pop('r7ExclusivePrefix',None)
        protocol['publication']['campaignExclusivePrefix']=True
        protocol['nativeProfiling']['unavailableStatus']='R12R12_NATIVE_PROFILER_UNAVAILABLE'
    wave.save('baseline/preregistered-protocol.json',protocol)
    wave.save('baseline/budget.json',dict(json.loads((source/'baseline/budget.json').read_text()),approvedByTaskSha256=sha256(task)))
    wave.save('baseline/prior-publications.json',{'sourceCampaign':config.get('scientificCampaign','AP-06-R12-R10-factorial'),
        'sourceCorpusManifestSha256':sha256(origin/'manifests/corpus.json'),'corpusPublication':publication,
        'newIdentity':True,'newDpapiSeal':True,'historicalModified':False})
    artifacts={key:sha256(wave.output/'tooling/backend-build'/name) for key,name in NATIVE_FILES.items()}
    wave.save('baseline/native-binary-reuse.json',{'status':'PASS','method':f'fresh R{round_number} CMake/Ninja build',
        'artifacts':artifacts,'sourceFiles':native_source_files(wave),
        'crowHeaderSha256':sha256(wave.root/'backend/include/crow_all.h')})
    validate_native_build_authority(wave)
    validate_r8_corpus(wave)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--source-output',type=Path,required=True)
    args=parser.parse_args();wave=Wave(Path(__file__).resolve().parents[2])
    wave.output=wave.root/'.quality/readiness-wave12-r11-factorial'
    prepare(wave,args.source_output)
    print(json.dumps({'status':'PASS','newAuthority':True,'scientificChromium':0,'reservationCreated':False}))
