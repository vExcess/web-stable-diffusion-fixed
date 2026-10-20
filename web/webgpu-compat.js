/**
 * Restore GPUAdapter.requestAdapterInfo() for older TVM web runtimes.
 *
 * Chrome removed the async method after WebGPU replaced it with the
 * synchronous GPUAdapter.info attribute. The bundled tvmjs runtime still
 * calls requestAdapterInfo() during detectGPUDevice().
 */
(function () {
  if (typeof GPUAdapter === "undefined") {
    return;
  }
  if (typeof GPUAdapter.prototype.requestAdapterInfo === "function") {
    return;
  }
  GPUAdapter.prototype.requestAdapterInfo = function () {
    return Promise.resolve(this.info);
  };
})();
