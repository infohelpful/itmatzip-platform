"""AutoSubtitle web engine: the desktop AutoSubtitle sidecar and main-process logic, served over HTTP.

``sidecar/`` is a verbatim copy of the desktop repo's ``python_sidecar`` (see ``SIDECAR_SOURCE``)
and runs as its own subprocess, exactly like Electron runs it, so transcription and alignment
results match the desktop app. The other modules port the Electron main process (media
preparation, PCM reads, fingerprints, waveform cache) to Python.
"""

SIDECAR_SOURCE = "infohelpful/1.-AutoSubtitle@5379aa6 python_sidecar/"
