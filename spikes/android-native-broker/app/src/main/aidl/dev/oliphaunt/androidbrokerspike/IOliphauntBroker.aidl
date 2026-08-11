package dev.oliphaunt.androidbrokerspike;

import android.os.Bundle;
import android.os.ParcelFileDescriptor;

/** Minimal experimental control plane. Bulk protocol bytes use dataChannel. */
interface IOliphauntBroker {
    Bundle hello(in Bundle request, in ParcelFileDescriptor dataChannel);
    Bundle control(in Bundle request);
}
