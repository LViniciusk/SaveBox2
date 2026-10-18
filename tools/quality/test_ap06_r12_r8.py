import contextlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from run_readiness_wave1 import WaveFailure
from run_ap06_integration_probe import build_products
import ap06_local_backend as local_backend
import run_ap06_r12_r2 as factorial

_previous_campaign=None

def setUpModule():
    global _previous_campaign
    _previous_campaign=(factorial.OUTPUT,factorial.CAMPAIGN,factorial.PUBLISHER)
    factorial.configure_campaign('.quality/readiness-wave12-r8-factorial',Path(__file__).resolve(),'AP-06-R12-R8-factorial')

def tearDownModule():
    factorial.OUTPUT,factorial.CAMPAIGN,factorial.PUBLISHER=_previous_campaign


class ProductTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.app=self.root/'.quality/readiness-wave12-r8-factorial/tooling/app'
        self.browser=self.app/'browser'
        self.browser.mkdir(parents=True)
        (self.browser/'index.html').write_text('<html></html>')
        for name in ('main.js','crypto.js','transmux.js'):(self.browser/name).write_text(name)
        self.outputs={
            'main.js':{'entryPoint':'experiments/ap06-r7/main.ts'},
            'crypto.js':{'entryPoint':'frontend/src/stream-crypto.worker.ts'},
            'transmux.js':{'entryPoint':'frontend/src/stream-transmux.worker.ts'},
        }
        self.write_stats()

    def tearDown(self):self.temp.cleanup()

    def write_stats(self,outputs=None):
        (self.app/'stats.json').write_text(json.dumps({'outputs':self.outputs if outputs is None else outputs}))

    def test_complete_app_products_return_workers_and_hashes(self):
        assets,products,workers=build_products(self.root,'.quality/readiness-wave12-r8-factorial')
        self.assertEqual(set(workers),{'crypto','transmux'})
        self.assertEqual(set(assets),{'/','/main.js','/crypto.js','/transmux.js'})
        self.assertTrue(all(len(row['sha256'])==64 for row in workers.values()))
        self.assertTrue(all(len(digest)==64 for digest in products.values()))

    def test_missing_browser_or_index_is_classified(self):
        moved=self.browser.with_name('browser-unused')
        self.browser.rename(moved)
        with self.assertRaisesRegex(WaveFailure,'R12R8_APP_PRODUCTS_MISSING'):build_products(self.root,'.quality/readiness-wave12-r8-factorial')
        moved.rename(self.browser)
        (self.browser/'index.html').unlink()
        with self.assertRaisesRegex(WaveFailure,'R12R8_APP_PRODUCTS_MISSING'):build_products(self.root,'.quality/readiness-wave12-r8-factorial')

    def test_missing_or_invalid_stats_and_outputs_are_classified(self):
        (self.app/'stats.json').unlink()
        with self.assertRaisesRegex(WaveFailure,'R12R8_APP_STATS_INVALID'):build_products(self.root,'.quality/readiness-wave12-r8-factorial')
        (self.app/'stats.json').write_text('{')
        with self.assertRaisesRegex(WaveFailure,'R12R8_APP_STATS_INVALID'):build_products(self.root,'.quality/readiness-wave12-r8-factorial')
        for outputs in ([],{}, {'main.js':[]}, {'main.js':{'entryPoint':'x'}}):
            self.write_stats(outputs)
            with self.subTest(outputs=outputs),self.assertRaises(WaveFailure):build_products(self.root,'.quality/readiness-wave12-r8-factorial')

    def test_missing_bundle_ambiguous_workers_and_cross_campaign_path_fail(self):
        (self.browser/'main.js').unlink()
        with self.assertRaisesRegex(WaveFailure,'R12R8_APP_PRODUCTS_MISSING'):build_products(self.root,'.quality/readiness-wave12-r8-factorial')
        (self.browser/'main.js').write_text('main.js')
        for outputs,reason in (
            ({'main.js':self.outputs['main.js'],'transmux.js':self.outputs['transmux.js']},'R12R8_WORKER_PRODUCTS_INVALID'),
            ({**self.outputs,'crypto-copy.js':{'entryPoint':'frontend/src/stream-crypto.worker.ts'}},'R12R8_WORKER_PRODUCTS_INVALID'),
            ({**self.outputs,'../readiness-wave8/foreign.js':{'entryPoint':'x'}},'R12R8_APP_PRODUCTS_MISSING'),
        ):
            if 'crypto-copy.js' in outputs:(self.browser/'crypto-copy.js').write_text('copy')
            self.write_stats(outputs)
            with self.subTest(reason=reason),self.assertRaisesRegex(WaveFailure,reason):build_products(self.root,'.quality/readiness-wave12-r8-factorial')

    def test_index_referenced_bundle_must_exist(self):
        (self.browser/'index.html').write_text('<script type="module" src="missing.js"></script>')
        with self.assertRaisesRegex(WaveFailure,'R12R8_APP_PRODUCTS_MISSING'):
            build_products(self.root,'.quality/readiness-wave12-r8-factorial')

    def test_inline_component_css_is_not_mistaken_for_an_emitted_bundle(self):
        self.write_stats({**self.outputs,'component.css':{'ng-component':True}})
        build_products(self.root,'.quality/readiness-wave12-r8-factorial')
        self.write_stats({**self.outputs,'global.css':{}})
        with self.assertRaisesRegex(WaveFailure,'R12R8_APP_PRODUCTS_MISSING'):
            build_products(self.root,'.quality/readiness-wave12-r8-factorial')

    def test_worker_receipt_detects_changed_hash(self):
        _,products,workers=build_products(self.root,'.quality/readiness-wave12-r8-factorial')
        receipt={'status':'PASS','products':products,'workers':workers}
        factorial.validate_r8_product_receipt(receipt,products,workers)
        (self.browser/'crypto.js').write_text('changed')
        _,changed_products,changed_workers=build_products(self.root,'.quality/readiness-wave12-r8-factorial')
        with self.assertRaisesRegex(WaveFailure,'R12R8_WORKER_HASH_MISMATCH'):
            factorial.validate_r8_product_receipt(receipt,changed_products,changed_workers)

    def test_preflight_requires_both_native_suites_and_exact_reused_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);output=root/'.quality/readiness-wave12-r8-factorial';baseline=output/'baseline';build=output/'tooling/backend-build'
            baseline.mkdir(parents=True);build.mkdir(parents=True)
            header=root/'backend/include/crow_all.h';header.parent.mkdir(parents=True);header.write_text('owned header')
            for name,contents in {'nanika_ap06_local_server.exe':b'server','savebox_tests.exe':b'production',
                    'nanika_ap06_tests.exe':b'experimental','compile_commands.json':b'compile','CMakeCache.txt':b'cache'}.items():
                (build/name).write_bytes(contents)
            backend={'status':'PASS','binarySha256':factorial.sha256(build/'nanika_ap06_local_server.exe'),
                'compileCommandsSha256':factorial.sha256(build/'compile_commands.json'),
                'cmakeCacheSha256':factorial.sha256(build/'CMakeCache.txt'),'crowHeaderSha256':factorial.sha256(header),
                'crowHeaderSource':'reused R7 build receipt; ignored amalgamated header unavailable'}
            artifacts={'server':backend['binarySha256'],'compileCommands':backend['compileCommandsSha256'],
                'cmakeCache':backend['cmakeCacheSha256'],'productionTests':factorial.sha256(build/'savebox_tests.exe'),
                'experimentalTests':factorial.sha256(build/'nanika_ap06_tests.exe')}
            suites={}
            for kind in ('production','experimental'):
                path=baseline/f'native-{kind}.xml';path.write_text(f'<{kind}/>')
                suites[kind]={'status':'PASS','assertionsPassed':10,'assertionsFailed':0,'expectedFailures':0,
                    'casesPassed':1,'casesFailed':0,'xmlSha256':factorial.sha256(path)}
            (baseline/'experimental-backend.json').write_text(json.dumps(backend))
            (baseline/'native-binary-reuse.json').write_text(json.dumps({'status':'PASS','artifacts':artifacts}))
            (baseline/'native-tests-summary.json').write_text(json.dumps({'status':'PASS','seed':60102,'suites':suites}))
            wave=type('Wave',(),{'root':root,'output':output})()
            self.assertEqual(factorial.validate_r8_native_tests(wave)['status'],'PASS')
            suites['experimental']['casesFailed']=1
            (baseline/'native-tests-summary.json').write_text(json.dumps({'status':'PASS','seed':60102,'suites':suites}))
            with self.assertRaisesRegex(WaveFailure,'R12R8_PREFLIGHT_NOT_READY'):factorial.validate_r8_native_tests(wave)

    def test_global_quality_gate_accepts_only_the_four_unchanged_document_boundaries(self):
        with tempfile.TemporaryDirectory() as temporary:
            output=Path(temporary)/'.quality/readiness-wave12-r8-factorial';baseline=output/'baseline';baseline.mkdir(parents=True)
            record={'status':'DOCUMENTED_EXCEPTION','tests':531,'failures':4,'errors':0,
                'failureClass':'preexisting documentation boundaries','failureFiles':['docs/arquitetura/visao-geral.md',
                    'docs/arquitetura/frontend.md','docs/arquitetura/backend.md','docs/arquitetura/deployment.md'],
                'historicalFailureDocumentsUnchanged':True,'snapshotSha256':'a'*64}
            path=baseline/'global-quality-r8.json';path.write_text(json.dumps(record))
            wave=type('Wave',(),{'output':output})()
            self.assertEqual(factorial.validate_r8_global_quality(wave)['status'],'DOCUMENTED_EXCEPTION')
            record['errors']=1;path.write_text(json.dumps(record))
            with self.assertRaisesRegex(WaveFailure,'R12R8_PREFLIGHT_NOT_READY'):factorial.validate_r8_global_quality(wave)

    def test_dependency_audit_is_bound_to_the_lock_and_runtime_scope(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);output=root/'.quality/readiness-wave12-r8-factorial';baseline=output/'baseline';baseline.mkdir(parents=True)
            lock=root/'frontend/package-lock.json';lock.parent.mkdir(parents=True);lock.write_text('{}')
            all_counts={'info':0,'low':0,'moderate':7,'high':20,'critical':3,'total':30}
            runtime_counts={'info':0,'low':0,'moderate':0,'high':1,'critical':0,'total':1}
            report={'status':'PASS','counts':all_counts,'findings':[{} for _ in range(30)]}
            runtime={'status':'PASS','counts':runtime_counts,'findings':[{'package':'@angular/router','severity':'high'}]}
            audit={'status':'RECORDED_NO_UPGRADES','upgradePerformed':False,'packageLockSha256':factorial.sha256(lock),
                'reports':{'all':report,'runtime':runtime}}
            path=baseline/'dependency-audit.json';path.write_text(json.dumps(audit))
            wave=type('Wave',(),{'root':root,'output':output})()
            self.assertEqual(factorial.validate_r8_dependency_audit(wave)['status'],'RECORDED_NO_UPGRADES')
            audit['packageLockSha256']='b'*64;path.write_text(json.dumps(audit))
            with self.assertRaisesRegex(WaveFailure,'R12R8_PREFLIGHT_NOT_READY'):factorial.validate_r8_dependency_audit(wave)

    def test_offline_identity_accepts_missing_pe_versioninfo_only_with_frozen_chromium_version(self):
        identity={'chromiumVersion':factorial.VERSION}
        factorial.validate_r8_browser_identity(identity,{'status':'PASS','productVersion':None})
        factorial.validate_r8_browser_identity(identity,{'status':'PASS','productVersion':factorial.VERSION})
        for changed_identity,observed in (
            ({'chromiumVersion':'0.0.0.0'},{'status':'PASS','productVersion':None}),
            (identity,{'status':'PASS','productVersion':'0.0.0.0'}),
            (identity,{'status':'PASS'}),
            (identity,{'status':'STOP','productVersion':None}),
            (None,{'status':'PASS','productVersion':None}),
        ):
            with self.subTest(identity=changed_identity,observed=observed),self.assertRaisesRegex(WaveFailure,'R12R8_PREFLIGHT_NOT_READY'):
                factorial.validate_r8_browser_identity(changed_identity,observed)

    def test_preflight_requires_a_clean_gitleaks_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            output=Path(temporary)/'.quality/readiness-wave12-r8-factorial';baseline=output/'baseline';baseline.mkdir(parents=True)
            (baseline/'secret-scan.json').write_text('[]')
            receipt={'status':'PASS','scanner':'gitleaks','version':'v8.30.1','findings':0,'stagedFiles':10}
            path=baseline/'secret-scan-receipt.json';path.write_text(json.dumps(receipt))
            wave=type('Wave',(),{'output':output})()
            self.assertEqual(factorial.validate_r8_secret_scan(wave)['status'],'PASS')
            receipt['findings']=1;path.write_text(json.dumps(receipt))
            with self.assertRaisesRegex(WaveFailure,'R12R8_PREFLIGHT_NOT_READY'):factorial.validate_r8_secret_scan(wave)

    def test_reparse_point_is_rejected_when_supported(self):
        outside=self.root/'outside.js';outside.write_text('foreign')
        target=self.browser/'foreign.js'
        try:target.symlink_to(outside)
        except (OSError,NotImplementedError):self.skipTest('Symlinks are unavailable on this host')
        with self.assertRaisesRegex(WaveFailure,'R12R8_APP_PRODUCTS_MISSING'):build_products(self.root,'.quality/readiness-wave12-r8-factorial')

    def test_failed_or_preused_build_does_not_publish_products_or_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);output=root/'.quality/readiness-wave12-r8-factorial';output.mkdir(parents=True)
            wave=type('Wave',(),{'root':root,'output':output,'save':lambda *args:None})()
            def partial_build(*args):
                partial=output/'tooling/app/browser';partial.mkdir(parents=True,exist_ok=True);(partial/'index.html').write_text('partial')
                raise WaveFailure('COMMAND_FAILED')
            with patch.object(factorial,'private_permissions'),patch.object(factorial,'npm_command',return_value='npm'),\
                    patch.object(factorial,'preflight_build_inputs',return_value={'input':'a'}),\
                    patch.object(wave,'command',side_effect=partial_build,create=True) as command:
                with self.assertRaisesRegex(WaveFailure,'R12R8_APP_BUILD_FAILED'):factorial.prepare_preflight_assets(wave)
                command.assert_called_once()
                self.assertTrue((output/'tooling/app/browser/index.html').is_file())
                self.assertFalse((output/'tooling/app-products.json').exists())
            (output/'tooling/freeze.json').parent.mkdir(parents=True,exist_ok=True)
            (output/'tooling/freeze.json').write_text('{}')
            with patch.object(factorial,'private_permissions'),patch.object(wave,'command',create=True) as command:
                with self.assertRaisesRegex(WaveFailure,'R12R8_APP_BUILD_FAILED'):factorial.prepare_preflight_assets(wave)
                command.assert_not_called()

    def test_r8_reuses_r7_backend_receipt_when_ignored_crow_header_is_absent(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);output=root/'.quality/readiness-wave12-r8-factorial';build=output/'tooling/backend-build'
            (build).mkdir(parents=True);(output/'baseline').mkdir(parents=True)
            (build/'nanika_ap06_local_server.exe').write_bytes(b'R7-server')
            (build/'CMakeCache.txt').write_text('R7-cache')
            (build/'compile_commands.json').write_text(json.dumps([
                {'command':'g++ CMakeFiles/nanika_ap06_local_server.dir/main.cpp -DNANIKA_AP06_LOCAL_TEST_SERVER=1'},
                {'command':'g++ CMakeFiles/savebox_server.dir/main.cpp'},
                {'command':'g++ CMakeFiles/nanika_ap06_tests.dir/test.cpp -DNANIKA_AP06_LOCAL_TEST_SERVER=1'},
                {'command':'g++ CMakeFiles/savebox_tests.dir/test.cpp'},
                {'command':'g++ CMakeFiles/nanika_e2e_fixture.dir/fixture.cpp'},
            ]))
            prior={'status':'PASS','binarySha256':factorial.sha256(build/'nanika_ap06_local_server.exe'),
                'compileCommandsSha256':factorial.sha256(build/'compile_commands.json'),
                'cmakeCacheSha256':factorial.sha256(build/'CMakeCache.txt'),'crowHeaderSha256':'a'*64}
            (output/'baseline/experimental-backend.json').write_text(json.dumps(prior))
            with patch.object(local_backend,'ROOT',root),patch.object(local_backend,'OUTPUT',output),\
                    patch('ap06_freeze.validate_native_build_authority',return_value=prior) as authority,\
                    patch.object(local_backend.subprocess,'check_output',side_effect=['Nanika AP06 local laboratory R10-R3','14.3.0']):
                result=local_backend.verify_experimental_build()
                authority.assert_called_once()
            self.assertEqual(result['crowHeaderSha256'],'a'*64)
            self.assertEqual(result['crowHeaderSource'],'independently verified native build authority')

    def test_validated_r8_build_is_reused_without_a_second_build(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);output=root/'.quality/readiness-wave12-r8-factorial'
            browser=output/'tooling/app/browser';browser.mkdir(parents=True)
            (browser/'index.html').write_text('<html></html>')
            for name in ('main.js','crypto.js','transmux.js'):(browser/name).write_text(name)
            outputs={'main.js':{'entryPoint':'experiments/ap06-r7/main.ts'},
                'crypto.js':{'entryPoint':'src/stream-crypto.worker.ts'},
                'transmux.js':{'entryPoint':'src/stream-transmux.worker.ts'}}
            (output/'tooling/app/stats.json').write_text(json.dumps({'outputs':outputs}))
            wave=type('Wave',(),{'root':root,'output':output,'save':lambda *args:None})()
            commands=output/'pipeline/commands';commands.mkdir(parents=True)
            (commands/'r12-r8-angular-build.json').write_text(json.dumps({'status':'PASS','exitCode':0}))
            _,products,workers=build_products(root,'.quality/readiness-wave12-r8-factorial')
            (output/'tooling/app-products.json').write_text(json.dumps({'status':'PASS','inputs':{'input':'a'},
                'products':products,'workers':workers}))
            with patch.object(factorial,'preflight_build_inputs',return_value={'input':'a'}),\
                    patch.object(factorial,'private_permissions'),patch.object(wave,'command',create=True) as command:
                factorial.prepare_preflight_assets(wave)
                command.assert_not_called()


class ReservationOrderTests(unittest.TestCase):
    class FakeWave:
        def __init__(self,root):
            self.root=root;self.output=root/'.quality/readiness-wave12-r8-factorial';self.commands=[];self.node='node';self.output.mkdir(parents=True,exist_ok=True)
        def git(self,*args):return 'a'*40
        def command(self,*args):
            self.commands.append(args[0]);target=self.output/'tooling/angular-unit-1.json';target.parent.mkdir(parents=True,exist_ok=True)
            if not (self.output/'pipeline/development-reservation.json').exists():raise AssertionError('Node ran before reservation')
            target.write_text(json.dumps(raw_preflight()))
            return ''
        def save(self,relative,value):
            path=self.output/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value))

    def setUp(self):self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
    def tearDown(self):self.temp.cleanup()

    def wave(self):return self.FakeWave(self.root)

    def offline_failure(self,where):
        wave=self.FakeWave(self.root/where);calls=[]
        with patch.object(factorial,'validate_r8_preflight_authority',side_effect=WaveFailure('CI_FAIL') if where=='CI' else lambda w:calls.append('authority')),\
                patch.object(factorial,'prepare_preflight_assets',side_effect=WaveFailure('BUILD_FAIL') if where=='build' else lambda w:(calls.append('build') or ({}, {}, {}))),\
                patch.object(factorial,'environment',side_effect=WaveFailure('ENV_FAIL') if where=='environment' else lambda *a:(calls.append('environment') or ({},{}))),\
                patch.object(factorial,'media_files',return_value={'/video-0.mp4':Path('unused')}),\
                patch.object(factorial,'verify_preflight_dependencies',return_value={}),\
                patch.object(factorial,'media_server',side_effect=OSError('PORT_BUSY') if where=='media' else None),\
                patch.object(wave,'command') as node:
            with self.assertRaises(factorial.R8PreflightFailure) as raised:factorial.unit_browser_r8(wave)
        self.assertFalse((wave.output/'pipeline/development-reservation.json').exists())
        self.assertEqual(node.call_count,0)
        self.assertEqual(raised.exception.reservation_created,False)
        self.assertEqual(raised.exception.launch_attempts,0)
        self.assertEqual(raised.exception.browser_launches,0)

    def test_authority_build_environment_and_media_server_failures_reserve_nothing(self):
        for stage in ('CI','build','environment','media'):
            with self.subTest(stage=stage):self.offline_failure(stage)

    def test_all_offline_gates_and_listener_precede_one_reservation_and_one_node_call(self):
        wave=self.wave();events=[];assets={};workers={};products={}
        @contextlib.contextmanager
        def server(*args,**kwargs):events.append('media-server-ready');yield 'http://127.0.0.1:42088',{}
        def command(name,*args):
            events.append('node');self.assertTrue((wave.output/'pipeline/development-reservation.json').exists())
            return ReservationOrderTests.FakeWave.command(wave,name,*args)
        baseline=raw_preflight()
        values={
            'workload.json':{'rangesPerCycle':[],'bytesPerCycle':100},
            'manifest.json':[],
            'backend-authority.json':{'fileMapping':[]},
        }
        def fake_read(path):
            path=Path(path)
            return json.loads(path.read_text()) if path.name=='angular-unit-1.json' else values[path.name]
        with patch.object(factorial,'validate_r8_preflight_authority',side_effect=lambda w:events.append('authority')),\
                patch.object(factorial,'prepare_preflight_assets',side_effect=lambda w:(events.append('build') or (assets,products,workers))),\
                patch.object(factorial,'environment',side_effect=lambda *a:(events.append('environment') or ({},assets))),\
                patch.object(factorial,'media_files',return_value={'/video-0.mp4':Path('unused')}),\
                patch.object(factorial,'verify_preflight_dependencies',side_effect=lambda *a:(events.append('dependencies') or {})),\
                patch.object(factorial,'media_server',side_effect=server),\
                patch.object(factorial.socket,'create_connection',side_effect=lambda *a,**k:(events.append('listener') or contextlib.nullcontext())),\
                patch.object(factorial,'publish',side_effect=lambda w,n,f:events.append(n)),\
                patch.object(factorial,'read',side_effect=fake_read),patch.object(factorial,'validate_browser_receipt'),\
                patch.object(factorial,'expected_proof',return_value='proof'),patch.object(factorial,'validate_mixed_network',return_value=100),\
                patch.object(factorial,'validate_scalars'),patch.object(factorial,'transport_counts',return_value=[]),\
                patch.object(factorial,'sha256',return_value='a'*64),patch.object(wave,'command',side_effect=command):
            factorial.unit_browser_r8(wave)
        self.assertEqual(wave.commands,['r12-r8-preflight'])
        self.assertEqual(events[:7],['authority','build','environment','dependencies','media-server-ready','listener','development-reserved'])
        self.assertEqual(events.count('development-reserved'),1)


def raw_preflight():
    return {'status':'PASS','unitBrowserLaunchAttempts':1,'unitBrowserLaunches':1,'browserClosed':True,
        'processExitAudit':{'status':'PASS'},'browserIdentity':{'before':{'browserPid':10,'processCreationTime':100},
        'after':{'browserPid':10,'processCreationTime':100},'cleanupStatus':'PASS'},'cases':[{'status':'PASS','contextClosed':True} for _ in range(5)],
        'rangeNetworks':{key:{'cdp':{},'backend':{}} for key in factorial.CONDITIONS},
        'transportProofs':dict.fromkeys(factorial.CONDITIONS,'proof'),
        'scalarCounters':{key:{} for key in factorial.CONDITIONS},'routingCounters':{key:[] for key in factorial.CONDITIONS}}


if __name__=='__main__':unittest.main()
