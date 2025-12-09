# backend/app.py
import os
import io
import base64
from typing import List, Dict, Any, Optional
from datetime import datetime

from fastapi import FastAPI, File, UploadFile, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image
import numpy as np

# Ultralytics YOLO
from ultralytics import YOLO

# Load config from env
API_KEY = os.getenv("API_KEY") or None
MODEL_PATH = os.getenv("MODEL_PATH", "model/best.pt")
CONF_THRESHOLD = float(os.getenv("CONF_THRESHOLD", "0.35"))
MAX_FILE_SIZE = int(os.getenv("MAX_FILE_SIZE", str(8 * 1024 * 1024)))  # bytes

app = FastAPI(title="Marg-AI Inference (FastAPI + YOLO)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # change in prod
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global model variable
model: Optional[YOLO] = None


# --- Helpers ---
def require_api_key(x_api_key: Optional[str] = Header(None)):
    if API_KEY:
        if not x_api_key or x_api_key != API_KEY:
            raise HTTPException(status_code=401, detail="Unauthorized")


def pil_to_base64_thumb(img: Image.Image, max_size=(320, 320), quality=70) -> str:
    thumb = img.copy()
    thumb.thumbnail(max_size)
    buffer = io.BytesIO()
    thumb.save(buffer, format="JPEG", quality=quality)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def parse_results(results, conf_threshold=0.35) -> List[Dict[str, Any]]:
    """
    Convert ultralytics results to list of detections:
    [{ label, conf, xyxy: [x1,y1,x2,y2] }, ...]
    """
    detections: List[Dict[str, Any]] = []
    # results may be an iterable; typically results[0] is for the single image
    r0 = results[0]
    # boxes: xyxy, conf, cls
    if hasattr(r0, "boxes") and r0.boxes is not None:
        boxes = r0.boxes
        # boxes.xyxy, boxes.conf, boxes.cls are tensors or arrays
        try:
            xyxy = boxes.xyxy.cpu().numpy()
            confidences = boxes.conf.cpu().numpy()
            classes = boxes.cls.cpu().numpy().astype(int)
        except Exception:
            # fallback if already numpy
            xyxy = np.array(boxes.xyxy)
            confidences = np.array(boxes.conf)
            classes = np.array(boxes.cls).astype(int)

        for (box, conf, cls) in zip(xyxy, confidences, classes):
            if conf < conf_threshold: 
                continue
            x1, y1, x2, y2 = box.tolist()
            label = model.names.get(int(cls), str(cls)) if hasattr(model, "names") else str(cls)
            detections.append({
                "label": str(label),
                "conf": float(conf),
                "xyxy": [float(x1), float(y1), float(x2), float(y2)],
            })
    return detections


# --- Startup: load model once ---
@app.on_event("startup")
async def load_model():
    global model
    try:
        model = YOLO(MODEL_PATH)
        # warm up with a tiny inference (optional)
        # model.predict(np.zeros((1, 64, 64, 3), dtype=np.uint8))
        app.logger = getattr(app, "logger", None)
        print(f"Loaded model from {MODEL_PATH}")
    except Exception as e:
        print(f"Failed loading model {MODEL_PATH}: {e}")
        model = None


# --- Routes ---
@app.get("/")
async def health():
    return {"status": "ok", "model_loaded": model is not None, "time": datetime.utcnow().isoformat() + "Z"}


@app.post("/detect")
async def detect(frame: UploadFile = File(...), x_api_key: Optional[str] = Header(None, alias="x-api-key")):
    # API key check
    if API_KEY:
        if not x_api_key or x_api_key != API_KEY:
            raise HTTPException(status_code=401, detail="Unauthorized")

    if not model:
        raise HTTPException(status_code=500, detail="Model not loaded")

    # Basic file size check
    content = await frame.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large")

    # Load image via PIL
    try:
        image = Image.open(io.BytesIO(content)).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image: {e}")

    frame_w, frame_h = image.width, image.height

    # Run model (Ultralytics YOLO) - pass in np array or PIL directly
    try:
        # model expects path or np array; pass np array (H,W,3)
        np_img = np.array(image)
        results = model.predict(source=np_img, conf=CONF_THRESHOLD, verbose=False)  # returns Results object
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inference error: {e}")

    # Parse detections
    detections = parse_results(results, conf_threshold=CONF_THRESHOLD)

    # Build alerts: create alert entries for detections above a higher threshold (optional)
    ALERT_CONF = float(os.getenv("ALERT_CONF_THRESHOLD", "0.5"))
    alerts = []
    for det in detections:
        if det["conf"] >= ALERT_CONF:
            # create thumbnail base64 (small) for quick preview
            thumb_b64 = pil_to_base64_thumb(image, max_size=(320, 320))
            alerts.append({
                "label": det["label"],
                "conf": det["conf"],
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "thumb": thumb_b64
            })

    # Optionally: Save the uploaded file to disk for debugging (comment out in prod)
    SAVE_UPLOADS = os.getenv("SAVE_UPLOADS", "true").lower() in ("1", "true", "yes")
    saved_path = None
    if SAVE_UPLOADS:
        uploads_dir = os.getenv("UPLOAD_DIR", "uploads")
        os.makedirs(uploads_dir, exist_ok=True)
        filename = f"{int(datetime.utcnow().timestamp()*1000)}_{frame.filename}"
        saved_path = os.path.join(uploads_dir, filename)
        with open(saved_path, "wb") as f:
            f.write(content)

    response = {
        "frame_w": frame_w,
        "frame_h": frame_h,
        "detections": detections,
        "alerts": alerts,
        "saved_path": saved_path
    }
    return response
