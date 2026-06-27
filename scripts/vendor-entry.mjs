// Source entry bundled by esbuild into vendor/nsfw-bundle.js.
// Pulls TensorFlow.js + the NSFWjs CORE (no models) + ONLY the mobilenet_v2
// model into one offline ES module. Importing nsfwjs's top-level entry would
// inline all three models (~40 MB); core + one model is ~3 MB.
import * as tf from "@tensorflow/tfjs";
import { load } from "nsfwjs/core";
import { MobileNetV2Model } from "nsfwjs/models/mobilenet_v2";

// Loads the classifier entirely from inlined weights — no network calls.
export function loadModel() {
  return load("MobileNetV2", { modelDefinitions: [MobileNetV2Model] });
}

export { tf };
