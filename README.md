# 像素皮膚工坊

上傳照片，生成 64×64 Minecraft 皮膚。開啟 AI 轉換時，Nano Banana（Gemini 圖片模型）會先把照片畫成 Minecraft 角色，網頁再把那張圖對應到標準皮膚格式。

- `docs/`：網頁（GitHub Pages）。`config.js` 填代理伺服器網址。
- `proxy/`：Cloud Run 代理伺服器，負責保管 Google 憑證並呼叫模型，沒有任何相依套件。

## 部署代理伺服器（Cloud Run）

需要先安裝 [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) 並執行 `gcloud auth login`，專案要開啟計費。

```powershell
$P = "你的專案ID"
gcloud config set project $P
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com aiplatform.googleapis.com
```

**用 Vertex AI（Google Cloud 計費，不需要 API 金鑰）**：讓 Cloud Run 的預設服務帳戶可以呼叫 Gemini。

```powershell
$N = gcloud projects describe $P --format="value(projectNumber)"
gcloud projects add-iam-policy-binding $P --member="serviceAccount:$N-compute@developer.gserviceaccount.com" --role="roles/aiplatform.user"
```

**部署**（在 `proxy` 資料夾執行；用 AI Studio 金鑰的話在 `--set-env-vars` 加上 `,GEMINI_API_KEY=你的金鑰`）：

```powershell
gcloud run deploy mc-skin-proxy --source . --region asia-east1 --allow-unauthenticated `
  --max-instances 2 --concurrency 4 --timeout 180 --memory 512Mi `
  --set-env-vars "MODEL=gemini-3.1-flash-image,ALLOWED_ORIGINS=https://moemuom9488m.github.io,ACCESS_CODE=自訂存取碼,RATE_PER_HOUR=40"
```

`--allow-unauthenticated` 讓瀏覽器可以直接呼叫這個服務，所以任何知道網址的人都能送請求。下列設定用來限制濫用，**不要省略 `ACCESS_CODE`**：

| 環境變數 | 用途 |
|---|---|
| `ACCESS_CODE` | 存取碼，網頁上輸入正確才會呼叫模型 |
| `ALLOWED_ORIGINS` | 只回應這些網站來源的瀏覽器請求 |
| `RATE_PER_HOUR` | 每個 IP 每小時次數上限（預設 40；每次生成約用 2 次：轉換＋審查） |
| `REVIEW_MODEL` | 審查用的模型，預設 `gemini-2.5-flash` |
| `MODEL` | 模型 ID，預設 `gemini-3.1-flash-image`（Nano Banana 2） |
| `VERTEX_LOCATION` | Vertex AI 區域，預設 `global` |

`--max-instances 2` 也限制了最高同時用量。建議再到 Cloud Console 設定預算警示。

部署完成後，把顯示的網址填進 `docs/config.js` 的 `base`，commit 並 push，網頁就會出現「AI 轉換」選項。

檢查服務：`curl https://<網址>/api/health`（Cloud Run 保留了 `/healthz`，不能用）
