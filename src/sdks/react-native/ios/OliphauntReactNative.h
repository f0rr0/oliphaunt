#import <Foundation/Foundation.h>

#ifdef RCT_NEW_ARCH_ENABLED
#import <OliphauntReactNativeSpec/OliphauntReactNativeSpec.h>
#import <ReactCommon/RCTTurboModuleWithJSIBindings.h>

@interface Oliphaunt : NSObject <NativeOliphauntSpec, RCTTurboModuleWithJSIBindings>
@end
#else
#import <React/RCTBridgeModule.h>

@interface Oliphaunt : NSObject <RCTBridgeModule>
@end
#endif
