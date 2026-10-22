#import "Mixed.h"

@interface ExpoUmbrellaObjcView : UIView
@end

#import "MixedPrivate.h"

@implementation ExpoUmbrellaObjcView
@end

int expo_umbrella_fixture_value(void) {
  return [ExpoUmbrellaSwiftValue value];
}
