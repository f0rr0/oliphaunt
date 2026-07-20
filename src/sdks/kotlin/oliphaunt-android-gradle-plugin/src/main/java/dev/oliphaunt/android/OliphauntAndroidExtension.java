package dev.oliphaunt.android;

import javax.inject.Inject;
import org.gradle.api.model.ObjectFactory;
import org.gradle.api.provider.ListProperty;
import org.gradle.api.provider.MapProperty;
import org.gradle.api.provider.Property;

public abstract class OliphauntAndroidExtension {
  @Inject
  public OliphauntAndroidExtension(ObjectFactory objects) {
    getSelectedExtensions().convention(objects.listProperty(String.class).empty());
    getExtensionVersions().convention(objects.mapProperty(String.class, String.class).empty());
    getAndroidAbis().convention(objects.listProperty(String.class).value(java.util.List.of("arm64-v8a", "x86_64")));
  }

  public abstract Property<String> getLiboliphauntVersion();

  public abstract Property<Boolean> getIcu();

  /** Extension SQL names selected for exact runtime and native packaging. */
  public abstract ListProperty<String> getSelectedExtensions();

  public abstract MapProperty<String, String> getExtensionVersions();

  public abstract ListProperty<String> getAndroidAbis();
}
