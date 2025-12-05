export type RequestInitWithSignal = Omit<RequestInit, "signal"> & { signal?: AbortSignal };
