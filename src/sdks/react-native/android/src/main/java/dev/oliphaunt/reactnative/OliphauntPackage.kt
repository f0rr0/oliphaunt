package dev.oliphaunt.reactnative

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class OliphauntPackage : BaseReactPackage() {
  override fun getModule(
    name: String,
    reactContext: ReactApplicationContext,
  ): NativeModule? =
    if (name == OliphauntModule.NAME) {
      OliphauntModule(reactContext)
    } else {
      null
    }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
    ReactModuleInfoProvider {
      mapOf(
        OliphauntModule.NAME to ReactModuleInfo(
          OliphauntModule.NAME,
          OliphauntModule.NAME,
          false,
          false,
          false,
          true,
        ),
      )
    }
}
