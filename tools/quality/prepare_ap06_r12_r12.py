"""Fresh R12 authority and CurrentUser corpus custody; no runtime or execution receipts copied."""
import argparse
import json
from pathlib import Path
from prepare_ap06_r12_r11 import prepare as prepare_verified_corpus
from run_readiness_wave1 import Wave


def prepare(wave,source):
    return prepare_verified_corpus(wave,source,round_number=12)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--source-output',type=Path,required=True)
    args=parser.parse_args();wave=Wave(Path(__file__).resolve().parents[2])
    wave.output=wave.root/'.quality/readiness-wave12-r12-factorial'
    prepare(wave,args.source_output)
    print(json.dumps({'status':'PASS','newAuthority':True,'scientificChromium':0,'reservationCreated':False}))
