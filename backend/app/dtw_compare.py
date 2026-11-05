"""StepSync: confidence-aware, hip-centered, joint-angle DTW on Kaitlyn's CSV data.

Algorithm is post-session, not real-time. This does not train an ML model.
Scores are heuristic similarity scores; calibrate against labeled recordings.
"""
import csv
import math
from dataclasses import dataclass
from pathlib import Path

# MediaPipe Pose landmark IDs: left/right shoulders, elbows, wrists, hips, knees, ankles.
JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
# Angle uses center vertex and two adjacent endpoints.
ANGLES = {
    'left_elbow': (11, 13, 15), 'right_elbow': (12, 14, 16),
    'left_shoulder': (13, 11, 23), 'right_shoulder': (14, 12, 24),
    'left_knee': (23, 25, 27), 'right_knee': (24, 26, 28),
    'left_hip': (11, 23, 25), 'right_hip': (12, 24, 26),
}
REGIONS = {'Arms': ('left_elbow','right_elbow','left_shoulder','right_shoulder'),
           'Legs': ('left_knee','right_knee','left_hip','right_hip')}

@dataclass
class PoseFrame:
    time: float
    xyz: dict
    angles: dict


def _angle(a, b, c):
    u = [a[k]-b[k] for k in range(3)]
    v = [c[k]-b[k] for k in range(3)]
    nu = math.sqrt(sum(x*x for x in u)); nv = math.sqrt(sum(x*x for x in v))
    if nu < 1e-8 or nv < 1e-8: return None
    return math.acos(max(-1.0, min(1.0, sum(x*y for x,y in zip(u,v))/(nu*nv))))


def read_pose_csv(path: str | Path, sample_hz: float = 10.0, min_confidence: float = 0.5):
    """Read Kaitlyn's long-format CSV, keeping up to 10 pose samples per second.

    Use normalized 2D screen coordinates (plus relative depth if present), rather
    than world-space values which can be unstable in monocular video. Normalize
    translation and scale, but DO NOT rotate each frame (would hide orientation errors).
    """
    frames = {}
    with open(path, newline='', encoding='utf-8') as f:
        for r in csv.DictReader(f):
            try:
                index = int(r['frame_index']); joint = int(r['landmark_id'])
                if joint not in JOINTS: continue
                if r.get('pose_present','1').lower() in ('0','false'): continue
                vis = float(r.get('visibility') or 0)
                presence = float(r.get('presence') or 0)
                if min(vis,presence) < min_confidence: continue
                x = float(r['x_norm']); y = float(r['y_norm'])
                z = float(r.get('z_relative') or 0)
                if not all(math.isfinite(v) for v in (x,y,z)): continue
                row = frames.setdefault(index, {'time':float(r['timestamp_ms']) / 1000, 'points':{}})
                row['points'][joint] = (x,y,z)
            except (ValueError, TypeError, KeyError): continue
    result = []
    last = -1e9
    for _, frame in sorted(frames.items()):
        t = frame['time']
        if t < last + 1/sample_hz - 0.001: continue
        p = frame['points']
        if not (23 in p and 24 in p and 11 in p and 12 in p): continue
        hip = tuple((p[23][i]+p[24][i])/2 for i in range(3))
        shoulder = tuple((p[11][i]+p[12][i])/2 for i in range(3))
        # XY torso is a consistent camera-relative scale; 3D z is too uncertain
        scale = math.hypot(hip[0]-shoulder[0],hip[1]-shoulder[1])
        if scale < 0.025: continue
        norm = {j: tuple((v[i]-hip[i])/scale for i in range(3)) for j,v in p.items()}
        angles = {}
        for name, (a,b,c) in ANGLES.items():
            if a in norm and b in norm and c in norm:
                value = _angle(norm[a],norm[b],norm[c])
                if value is not None: angles[name] = value
        if len(angles) < 3: continue
        result.append(PoseFrame(t,norm,angles)); last=t
    return result


def pose_error(a: PoseFrame, b: PoseFrame):
    common = set(a.angles) & set(b.angles)
    if len(common) < 3: return 1.0
    # angle difference divided by pi. An arm in the wrong direction costs more.
    angle_err = sum(abs(a.angles[k]-b.angles[k])/math.pi for k in common)/len(common)
    # Limit missing joints and outliers. Use planar XY for camera portability.
    shared = set(a.xyz)&set(b.xyz)
    xy_err = sum(min(2.0, math.dist(a.xyz[k][:2],b.xyz[k][:2]))/2 for k in shared)/max(len(shared),1)
    return 0.75 * angle_err + 0.25 * xy_err


def _dtw(ref, usr, band_fraction=0.30):
    n,m=len(ref),len(usr)
    if n<3 or m<3: raise ValueError('Not enough usable body poses in one of the videos.')
    # Index-normalized band allows speed differences while limiting unrelated matches.
    band=max(8, math.ceil(max(n,m)*band_fraction))
    huge=float('inf')
    prev={(0):0.0}
    backs={}
    for i in range(1,n+1):
        current={}
        center=i*m/n
        lo=max(1,math.floor(center-band)); hi=min(m,math.ceil(center+band))
        for j in range(lo,hi+1):
            opts=[(prev.get(j-1,huge),(i-1,j-1)),
                  (prev.get(j,huge)+0.03,(i-1,j)),
                  (current.get(j-1,huge)+0.03,(i,j-1))]
            val,parent=min(opts, key=lambda x:x[0])
            if not math.isfinite(val): continue
            current[j]=val+pose_error(ref[i-1],usr[j-1]); backs[(i,j)]=parent
        prev=current
    if m not in prev: raise ValueError('Dance lengths differ too much for constrained DTW.')
    path=[]; pos=(n,m)
    while pos != (0,0):
        i,j=pos
        if i>0 and j>0: path.append((i-1,j-1))
        pos=backs[pos]
    path.reverse()
    return path


def compare_csv(reference_path, practice_path, sample_hz=10, reference_start=None, reference_end=None):
    ref=read_pose_csv(reference_path,sample_hz)
    if reference_start is not None and reference_end is not None:
        if not (math.isfinite(reference_start) and math.isfinite(reference_end) and 0 <= reference_start < reference_end):
            raise ValueError("Invalid tutorial step boundaries.")
        ref=[frame for frame in ref if reference_start <= frame.time <= reference_end]
    usr=read_pose_csv(practice_path,sample_hz)
    if len(ref)<6 or len(usr)<6:
        raise ValueError('Too few reliable poses detected. Use a full-body, well-lit video.')
    path=_dtw(ref,usr)
    mean_error=sum(pose_error(ref[i],usr[j]) for i,j in path)/len(path)
    # Report movement and timing separately. Scores are *uncalibrated* heuristics.
    movement=round(100*math.exp(-3*mean_error))
    # Tempo ratio (user duration / reference duration).
    ref_duration=max(0.001,ref[-1].time-ref[0].time)
    user_duration=max(0.001,usr[-1].time-usr[0].time)
    tempo_ratio=user_duration/ref_duration
    # Fraction of non-diagonal DTW links approximates local timing distortions.
    off_diagonal=sum(1 for p,q in zip(path,path[1:]) if p[0]==q[0] or p[1]==q[1])
    hesitation_fraction=off_diagonal/max(1,len(path)-1)
    timing=round(100*math.exp(-1.4*abs(math.log(tempo_ratio))-1.5*hesitation_fraction))
    region_errors={}
    for region,names in REGIONS.items():
        diffs=[abs(ref[i].angles[k]-usr[j].angles[k])/math.pi for i,j in path for k in names if k in ref[i].angles and k in usr[j].angles]
        if diffs:region_errors[region]=sum(diffs)/len(diffs)
    worst=max(region_errors,key=region_errors.get) if region_errors else 'body'
    steps=[]
    # Chunk by tutorial timeline, not evenly-spaced user frames.
    pieces=min(12,max(3,math.ceil(ref_duration/1.5)))
    for idx in range(pieces):
        start=ref[0].time+ref_duration*idx/pieces
        end=ref[0].time+ref_duration*(idx+1)/pieces
        local=[(i,j) for i,j in path if start<=ref[i].time<(end if idx<pieces-1 else end+1e-6)]
        if not local:continue
        cost=sum(pose_error(ref[i],usr[j]) for i,j in local)/len(local)
        u_start=usr[local[0][1]].time; u_end=usr[local[-1][1]].time
        movement_score=round(100*math.exp(-3*cost))
        local_off=sum(1 for a,b in zip(local,local[1:]) if a[0]==b[0] or a[1]==b[1])
        local_timing_score=round(100*math.exp(-1.5 * local_off / max(1,len(local)-1)))
        score=round(0.8*movement_score+0.2*local_timing_score)
        local_region_errors={}
        for region, names in REGIONS.items():
            diffs=[abs(ref[i].angles[k]-usr[j].angles[k])/math.pi for i,j in local
                   for k in names if k in ref[i].angles and k in usr[j].angles]
            if diffs: local_region_errors[region]=sum(diffs)/len(diffs)
        focus=max(local_region_errors,key=local_region_errors.get) if local_region_errors else 'body position'
        message=('Strong movement match.' if score>80 else
                 f'{focus} differ from the tutorial here. Replay this timestamp and practice slowly.' if score>=60 else
                 f'Large {focus} mismatch. Pause the tutorial, match your posture, then retry.')
        if local_timing_score < 80:
            message += ' Timing drifts in this section; rehearse to the tutorial beat.'
        steps.append({'id':str(idx+1),'label':f'Section {idx+1}',
                      'start':round(u_start,2),'end':round(max(u_start,u_end),2),
                      'score':score,'feedback':message, 'referenceStart':round(start,2), 'referenceEnd':round(end,2)})
    extra=((f'{worst} showed the largest average angular difference. ' if mean_error>0.02 else 'Body pose aligned closely. ')
           + f'Tempo: {tempo_ratio:.2f}× tutorial duration; local timing variation: {hesitation_fraction:.0%}. '
           'These scores are experimental; verify with human-labeled recordings.')
    if steps:steps[0]['feedback']+=' '+extra
    overall=round(0.8*movement + 0.2*timing)
    return {'overallScore':overall,'movementScore':movement,'timingScore':timing,
            'tempoRatio':round(tempo_ratio,3),'hesitationFraction':round(hesitation_fraction,3),
            'steps':steps, 'matchedPairs':len(path),'referenceSamples':len(ref),'practiceSamples':len(usr)}


if __name__=='__main__':
    import argparse,json
    parser=argparse.ArgumentParser(description='Compare two Kaitlyn pose CSV files')
    parser.add_argument('reference');parser.add_argument('practice');args=parser.parse_args()
    print(json.dumps(compare_csv(args.reference,args.practice),indent=2))
