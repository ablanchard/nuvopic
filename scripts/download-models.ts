import * as fs from "fs";
import * as path from "path";
import * as https from "https";

const FACE_API_MODELS_URL =
  "https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights";

const FACE_API_MODELS = [
  "ssd_mobilenetv1_model-weights_manifest.json",
  "ssd_mobilenetv1_model-shard1",
  "ssd_mobilenetv1_model-shard2",
  "face_landmark_68_model-weights_manifest.json",
  "face_landmark_68_model-shard1",
  "face_recognition_model-weights_manifest.json",
  "face_recognition_model-shard1",
  "face_recognition_model-shard2",
];

async function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    https
      .get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          // Handle redirect
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            file.close();
            fs.unlinkSync(dest);
            downloadFile(redirectUrl, dest).then(resolve).catch(reject);
            return;
          }
        }

        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          reject(new Error(`Failed to download ${url}: ${response.statusCode}`));
          return;
        }

        response.pipe(file);

        file.on("finish", () => {
          file.close();
          resolve();
        });
      })
      .on("error", (err) => {
        file.close();
        fs.unlinkSync(dest);
        reject(err);
      });
  });
}

async function downloadFaceApiModels(): Promise<void> {
  const modelsDir = path.join(process.cwd(), "models", "face-api");

  // Create directory if it doesn't exist
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }

  console.log("Downloading face-api.js models...");

  for (const model of FACE_API_MODELS) {
    const url = `${FACE_API_MODELS_URL}/${model}`;
    const dest = path.join(modelsDir, model);

    if (fs.existsSync(dest)) {
      console.log(`  ${model} (already exists)`);
      continue;
    }

    console.log(`  Downloading ${model}...`);
    await downloadFile(url, dest);
  }

  console.log("Face-api.js models downloaded successfully!");
}

async function main(): Promise<void> {
  try {
    await downloadFaceApiModels();

    console.log("\nNote: Transformers.js models will be downloaded automatically");
    console.log("on first use and cached in ~/.cache/huggingface/");

    console.log("\nAll models ready!");
  } catch (error) {
    console.error("Error downloading models:", error);
    process.exit(1);
  }
}

main();
