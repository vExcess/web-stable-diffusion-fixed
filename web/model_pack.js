const CACHE_SCOPE = "tvmjs";
const FORMAT = "web-stable-diffusion-cache-v1";

function defaultLogger(message) {
  console.log(message);
}

function safeBaseName(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const name = parts[parts.length - 1] || "file";
    return name.replace(/[^A-Za-z0-9._-]/g, "_");
  } catch (err) {
    return "file";
  }
}

function reportProgress(report, current, total, text) {
  if (typeof report === "function") {
    report({ current: current, total: total, text: text });
  }
}

export async function getModelCacheStatus() {
  if (typeof caches === "undefined") {
    return { count: 0, bytes: 0 };
  }
  const cache = await caches.open(CACHE_SCOPE);
  const keys = await cache.keys();
  return { count: keys.length, bytes: 0 };
}

export async function fetchAndCacheText(urls) {
  if (!urls || urls.length === 0) {
    throw Error("No tokenizer URLs were provided");
  }
  const cache = await caches.open(CACHE_SCOPE);
  for (let i = 0; i < urls.length; ++i) {
    const hit = await cache.match(urls[i]);
    if (!hit) {
      continue;
    }
    const text = await hit.text();
    try {
      JSON.parse(text);
      return text;
    } catch (err) {
      await cache.delete(urls[i]);
    }
  }

  let lastError = null;
  for (let i = 0; i < urls.length; ++i) {
    try {
      const response = await fetch(urls[i]);
      if (!response.ok) {
        throw Error("HTTP " + response.status + " for " + urls[i]);
      }
      const text = await response.text();
      JSON.parse(text);
      await cache.put(
        new Request(urls[i]),
        new Response(text, { headers: { "Content-Type": "application/json" } })
      );
      return text;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || Error("Failed to fetch tokenizer.json");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () {
    URL.revokeObjectURL(url);
  }, 4000);
}

function writeCString(buf, offset, value, max) {
  for (let i = 0; i < max; ++i) {
    buf[offset + i] = i < value.length ? value.charCodeAt(i) & 0xff : 0;
  }
}

function octalString(value, width) {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function tarHeader(name, size) {
  if (name.length > 100) {
    throw Error("Tar path is too long: " + name);
  }
  const header = new Uint8Array(512);
  writeCString(header, 0, name, 100);
  writeCString(header, 100, octalString(0o644, 8), 8);
  writeCString(header, 108, octalString(0, 8), 8);
  writeCString(header, 116, octalString(0, 8), 8);
  writeCString(header, 124, octalString(size, 12), 12);
  writeCString(header, 136, octalString(Math.floor(Date.now() / 1000), 12), 12);
  writeCString(header, 148, "        ", 8);
  header[156] = 0x30;
  writeCString(header, 257, "ustar", 6);
  writeCString(header, 263, "00", 2);
  let sum = 0;
  for (let i = 0; i < 512; ++i) {
    sum += header[i];
  }
  writeCString(header, 148, octalString(sum, 7), 7);
  header[155] = 0x20;
  return header;
}

function tarPadding(size) {
  const remainder = size % 512;
  return remainder === 0 ? 0 : 512 - remainder;
}

function isZeroBlock(block) {
  for (let i = 0; i < block.byteLength; ++i) {
    if (block[i] !== 0) {
      return false;
    }
  }
  return true;
}

function readCString(buf, offset, max) {
  let end = offset;
  const last = offset + max;
  while (end < last && buf[end] !== 0) {
    end += 1;
  }
  return new TextDecoder().decode(buf.subarray(offset, end));
}

function createTarStream(fileIterator) {
  const iterator = fileIterator[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {
        controller.enqueue(new Uint8Array(1024));
        controller.close();
        return;
      }
      const file = next.value;
      const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
      controller.enqueue(tarHeader(file.name, data.byteLength));
      if (data.byteLength) {
        controller.enqueue(data);
      }
      const pad = tarPadding(data.byteLength);
      if (pad) {
        controller.enqueue(new Uint8Array(pad));
      }
    }
  });
}

async function listCacheFiles(cache, keys) {
  const listed = [];
  for (let i = 0; i < keys.length; ++i) {
    const request = keys[i];
    const response = await cache.match(request);
    if (!response) {
      continue;
    }
    const fileName = String(i).padStart(4, "0") + "-" + safeBaseName(request.url);
    const blob = await response.blob();
    listed.push({
      request: request,
      url: request.url,
      file: "files/" + fileName,
      contentType: response.headers.get("content-type") || "application/octet-stream",
      size: blob.size
    });
  }
  return listed;
}

async function* cacheTarFiles(cache, listed, report) {
  const manifest = {
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    cacheScope: CACHE_SCOPE,
    entries: listed.map(function (item) {
      return {
        url: item.url,
        file: item.file,
        contentType: item.contentType,
        size: item.size
      };
    })
  };
  yield {
    name: "manifest.json",
    data: new TextEncoder().encode(JSON.stringify(manifest, null, 2))
  };
  for (let i = 0; i < listed.length; ++i) {
    reportProgress(report, i, listed.length, "Packing " + listed[i].file);
    const response = await cache.match(listed[i].request);
    if (!response) {
      throw Error("Cache entry disappeared while packing: " + listed[i].url);
    }
    yield {
      name: listed[i].file,
      data: new Uint8Array(await response.arrayBuffer())
    };
  }
}

async function exportAsTarGzip(cache, keys, options) {
  const logger = options.logger || defaultLogger;
  const report = options.report;
  const listed = await listCacheFiles(cache, keys);
  if (listed.length === 0) {
    throw Error("No model cache found yet. Click Generate once so the Hugging Face shards can download.");
  }

  const tarStream = createTarStream(cacheTarFiles(cache, listed, report));
  let outputStream = tarStream;
  let filename = "web-sd-model-cache.tar";
  if (typeof CompressionStream === "function") {
    outputStream = tarStream.pipeThrough(new CompressionStream("gzip"));
    filename = "web-sd-model-cache.tar.gz";
    reportProgress(report, 0, listed.length, "Compressing model cache to " + filename);
  } else {
    reportProgress(report, 0, listed.length, "Building " + filename);
  }

  const blob = await new Response(outputStream).blob();
  downloadBlob(blob, filename);
  logger(
    "Downloaded " + filename + " (" + listed.length +
    " files). In the other browser, click Load model cache and choose that file."
  );
  return { entries: listed };
}

function asUint8(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

async function readBytes(readerState, size) {
  if (size === 0) {
    return new Uint8Array(0);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    if (readerState.offset >= readerState.chunk.byteLength) {
      const result = await readerState.reader.read();
      if (result.done) {
        if (offset === 0) {
          return null;
        }
        throw Error("The tar archive ended unexpectedly");
      }
      readerState.chunk = asUint8(result.value);
      readerState.offset = 0;
      continue;
    }
    const take = Math.min(size - offset, readerState.chunk.byteLength - readerState.offset);
    out.set(readerState.chunk.subarray(readerState.offset, readerState.offset + take), offset);
    readerState.offset += take;
    offset += take;
  }
  return out;
}

async function skipBytes(readerState, size) {
  let remaining = size;
  while (remaining > 0) {
    if (readerState.offset >= readerState.chunk.byteLength) {
      const result = await readerState.reader.read();
      if (result.done) {
        throw Error("The tar archive ended unexpectedly");
      }
      readerState.chunk = asUint8(result.value);
      readerState.offset = 0;
      continue;
    }
    const take = Math.min(remaining, readerState.chunk.byteLength - readerState.offset);
    readerState.offset += take;
    remaining -= take;
  }
}

function entryLookupNames(entry) {
  const names = [];
  if (entry && entry.file) {
    names.push(entry.file);
    names.push(entry.file.split("/").pop());
  }
  return names;
}

async function importFromTarStream(stream, options) {
  const readerState = {
    reader: stream.getReader(),
    chunk: new Uint8Array(0),
    offset: 0
  };
  const logger = (options && options.logger) || defaultLogger;
  const report = options && options.report;
  const pending = Object.create(null);
  let expected = 0;
  let loaded = 0;
  let sawManifest = false;
  let cache = null;

  reportProgress(report, 0, 1, "Reading model cache archive...");

  try {
    while (true) {
      const header = await readBytes(readerState, 512);
      if (!header || isZeroBlock(header)) {
        break;
      }
      const name = readCString(header, 0, 100);
      const prefix = readCString(header, 345, 155);
      const fullName = prefix ? prefix + "/" + name : name;
      const size = parseInt(readCString(header, 124, 12), 8) || 0;
      const typeFlag = header[156];
      const pad = tarPadding(size);
      const isFile = typeFlag === 0 || typeFlag === 0x30;

      if (!isFile) {
        if (size) {
          await skipBytes(readerState, size);
        }
        if (pad) {
          await skipBytes(readerState, pad);
        }
        continue;
      }

      if (fullName === "manifest.json" || name === "manifest.json") {
        const data = await readBytes(readerState, size);
        if (pad) {
          await skipBytes(readerState, pad);
        }
        const manifest = JSON.parse(new TextDecoder().decode(data));
        if (!manifest || manifest.format !== FORMAT || !Array.isArray(manifest.entries)) {
          throw Error("The archive is not a Web Stable Diffusion model cache.");
        }
        expected = manifest.entries.length;
        for (let i = 0; i < manifest.entries.length; ++i) {
          const entry = manifest.entries[i];
          const names = entryLookupNames(entry);
          for (let j = 0; j < names.length; ++j) {
            pending[names[j]] = entry;
          }
        }
        sawManifest = true;
        cache = await caches.open(CACHE_SCOPE);
        reportProgress(report, 0, expected || 1, "Found " + expected + " cached files");
        continue;
      }

      if (!sawManifest) {
        throw Error("The archive is missing manifest.json.");
      }

      const entry = pending[fullName] || pending[name] || pending[fullName.split("/").pop()];
      if (!entry) {
        if (size) {
          await skipBytes(readerState, size);
        }
        if (pad) {
          await skipBytes(readerState, pad);
        }
        continue;
      }

      reportProgress(report, loaded, expected || 1, "Loading " + (entry.file || entry.url));
      const data = size ? await readBytes(readerState, size) : new Uint8Array(0);
      if (pad) {
        await skipBytes(readerState, pad);
      }
      await cache.put(
        new Request(entry.url),
        new Response(data, {
          headers: {
            "Content-Type": entry.contentType || "application/octet-stream"
          }
        })
      );
      loaded += 1;
      const names = entryLookupNames(entry);
      for (let i = 0; i < names.length; ++i) {
        delete pending[names[i]];
      }
    }
  } finally {
    try {
      readerState.reader.releaseLock();
    } catch (err) {
      // The stream may already be closed after a full read.
    }
  }

  if (!sawManifest) {
    throw Error("The archive is missing manifest.json.");
  }
  if (loaded !== expected) {
    throw Error("The archive is missing packed files (" + loaded + " of " + expected + " loaded).");
  }
  logger("Loaded " + loaded + " cached model files. Generate will use this local cache.");
}

function fileStream(file) {
  if (typeof file.stream === "function") {
    return file.stream();
  }
  return new Blob([file]).stream();
}

async function importFromTar(file, options) {
  const name = file.name || "";
  const sniff = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const isGzip = sniff.length >= 2 && sniff[0] === 0x1f && sniff[1] === 0x8b;
  let stream = fileStream(file);
  if (isGzip || /\.tgz$|\.tar\.gz$/i.test(name)) {
    if (typeof DecompressionStream !== "function") {
      throw Error("This browser cannot decompress .tar.gz. Use Firefox or Chrome 113+.");
    }
    stream = stream.pipeThrough(new DecompressionStream("gzip"));
  }
  await importFromTarStream(stream, options);
}

export async function exportModelCache(options) {
  options = options || {};
  if (typeof caches === "undefined") {
    throw Error("This browser does not expose a Cache API to export");
  }

  const cache = await caches.open(CACHE_SCOPE);
  const keys = await cache.keys();
  if (keys.length === 0) {
    throw Error("No model cache found yet. Click Generate once so the Hugging Face shards can download.");
  }

  return exportAsTarGzip(cache, keys, options);
}

function chooseFiles(fileInput) {
  return new Promise(function (resolve, reject) {
    if (!fileInput) {
      reject(Error("Choose the downloaded web-sd-model-cache.tar.gz file."));
      return;
    }
    const cleanup = function () {
      fileInput.removeEventListener("change", onChange);
      fileInput.removeEventListener("cancel", onCancel);
    };
    const onChange = function () {
      cleanup();
      const files = fileInput.files;
      if (!files || files.length === 0) {
        reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
        return;
      }
      resolve(files);
    };
    const onCancel = function () {
      cleanup();
      reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
    };
    fileInput.value = "";
    fileInput.addEventListener("change", onChange);
    fileInput.addEventListener("cancel", onCancel);
    if (typeof fileInput.showPicker === "function") {
      try {
        fileInput.showPicker();
        return;
      } catch (err) {
        // Some browsers only allow showPicker in a narrower gesture than click().
      }
    }
    fileInput.click();
  });
}

function isTarName(name) {
  return /(\.tar\.gz|\.tgz|\.tar)$/i.test(name || "");
}

export async function importModelCache(options) {
  options = options || {};
  if (typeof caches === "undefined") {
    throw Error("This browser does not expose a Cache API to import");
  }
  const logger = options.logger || defaultLogger;
  let files = options.files;
  if (!files || files.length === 0) {
    files = await chooseFiles(options.filesInput || options.fileInput);
  }
  if (!files || files.length !== 1) {
    throw Error("Choose one web-sd-model-cache.tar.gz (or .tar) file.");
  }
  const file = files[0];
  if (!isTarName(file.name) && file.type !== "application/gzip" && file.type !== "application/x-tar" && file.type !== "application/x-gzip") {
    throw Error("The cache must be a .tar.gz or .tar file.");
  }
  reportProgress(options.report, 0, 1, "Opening " + (file.name || "archive") + "...");
  logger("Reading " + (file.name || "archive") + " (" + file.size + " bytes)...");
  await importFromTar(file, options);
}
