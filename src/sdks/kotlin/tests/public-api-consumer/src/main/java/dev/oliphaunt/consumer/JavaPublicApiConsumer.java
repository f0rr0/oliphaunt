package dev.oliphaunt.consumer;

import android.content.Context;
import dev.oliphaunt.DatabaseStorage;
import dev.oliphaunt.ExtensionDescriptor;
import dev.oliphaunt.Extensions;
import dev.oliphaunt.IcuData;
import dev.oliphaunt.OliphauntConfig;
import dev.oliphaunt.OliphauntJava;
import java.io.File;
import java.util.Map;

/** Compile-only proof of the Java API against the packaged Android AAR. */
public final class JavaPublicApiConsumer {
    public static void useDatabase(Context context, File directory, ExtensionDescriptor vector, IcuData icu) {
        var config = OliphauntConfig.builder()
            .storage(new DatabaseStorage.Directory(directory))
            .startupGucs(Map.of("application_name", "java-consumer"))
            .extensions(vector, Extensions.HSTORE)
            .icu(icu)
            .build();
        try (var database = OliphauntJava.open(context, config)) {
            database.execute("CREATE EXTENSION vector");
            database.execute("CREATE EXTENSION hstore");
            database.query("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector");
        }
    }
}
