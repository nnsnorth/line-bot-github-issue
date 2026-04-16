from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from classify import Classifier

classifier: Classifier | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global classifier
    classifier = Classifier()
    print(f"Classifier ready — {len(classifier.examples)} examples loaded")
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health():
    return {"status": "ok", "examples": len(classifier.examples) if classifier else 0}


@app.post("/classify")
async def classify_ticket(request: Request):
    body = await request.json()
    message = body.get("message", "")
    result = classifier.classify(message)
    return result
