from pathlib import Path
from app.dtw_compare import compare_csv,read_pose_csv,_dtw

def _make_csv(p, stretch=1.0, bad=False):
    import csv,math
    joints=[11,12,13,14,15,16,23,24,25,26,27,28]
    rows=[]
    for frame in range(60):
        t=frame/10
        for j in joints:
            # hips and shoulders define scale and several rotating limbs define changing angles
            coords={11:(.45,.30),12:(.55,.30),23:(.45,.55),24:(.55,.55),
                    13:(.38,.38),14:(.62,.38),15:(.35,.45),16:(.65,.45),
                    25:(.43,.70),26:(.57,.70),27:(.4,.85),28:(.6,.85)}
            x,y=coords[j]
            if j in (13,15): x+=.06*math.sin(t*2.5)
            if j in (14,16): x-=.06*math.sin(t*2.5)
            if j in (25,27): x+=.05*math.sin(t*3)
            if bad and j==15: x+=.25
            rows.append([frame,round(t*1000*stretch),'OK',1,j,x,y,0,1,1])
    with open(p,'w',newline='') as f:
        w=csv.writer(f);w.writerow(['frame_index','timestamp_ms','frame_status','pose_present','landmark_id','x_norm','y_norm','z_relative','visibility','presence']);w.writerows(rows)

def test_same_pose_perfect(tmp_path):
    ref=tmp_path/'a.csv';_make_csv(ref)
    r=compare_csv(ref,ref)
    assert r['overallScore']==100
    assert r['timingScore']==100
    assert r['matchedPairs']>10

def test_slow_same_movements_not_graded_as_bad_pose(tmp_path):
    a=tmp_path/'a.csv';b=tmp_path/'b.csv';_make_csv(a);_make_csv(b,stretch=1.4)
    r=compare_csv(a,b)
    assert r['overallScore']>=90
    assert r['timingScore']<r['overallScore']

def test_wrong_wrist_penalty(tmp_path):
    a=tmp_path/'a.csv';b=tmp_path/'b.csv';_make_csv(a);_make_csv(b,bad=True)
    r=compare_csv(a,b)
    assert r['overallScore']<100
