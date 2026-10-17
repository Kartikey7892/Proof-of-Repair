# Python: model training & research (not the web app)

**The website and API are the Node.js server in [`../server/`](../server/).**
Nothing in this folder runs when you do `npm start`.

This folder holds the original Python code, kept for the parts Node can't do:

| Folder | Used for |
|--------|----------|
| `llm/` | Preparing datasets, fine-tuning the TinyLlama / Mistral LoRA models, evaluating them (needs PyTorch / MLX) |
| `por/`, `blockchain/`, `cloud/`, `utils/` | The reference implementation of the proof hashes and Merkle tree. `server/test/fixtures/gen_parity.py` uses it to check the Node code produces identical hashes. |

Related Python outside this folder:

- `../ml/inference_server.py` serves trained models to the Node server (only needed if you have trained adapters in `artifacts/adapters/`).
- `../tests/` are the Python reference tests (`python -m pytest tests/ -q`).
- `../scripts/` has the training and demo scripts.
