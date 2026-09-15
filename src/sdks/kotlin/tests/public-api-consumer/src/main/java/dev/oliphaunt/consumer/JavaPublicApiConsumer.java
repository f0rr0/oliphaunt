package dev.oliphaunt.consumer;

import android.content.Context;
import dev.oliphaunt.OliphauntJava;

/** Compile-only proof of Java overloads and ownership against the packaged AAR. */
public final class JavaPublicApiConsumer {
    public static void useDatabase(Context context) {
        try (var database = OliphauntJava.open(context)) {
            database.execute("CREATE TABLE items(value text)");
            database.query("SELECT value FROM items");
            database.exec("SELECT 1");
            database.backup();
            database.cancel();
        }
    }
}
