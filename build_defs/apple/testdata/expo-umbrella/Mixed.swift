import AliasFixture_Alias
import ExpoUmbrellaBase

public final class ExpoUmbrellaSwiftChild: ExpoUmbrellaSwiftBase {}

private let mixedQueue = DispatchQueue(label: "oliphaunt.expo.mixed")

@objc public class ExpoUmbrellaSwiftValue: NSObject {
  @objc public static func value() -> Int32 { 17 }

  @objc public static func aliasValue(_ value: ExpoUmbrellaAliasValue?) -> ExpoUmbrellaAliasValue? {
    value
  }
}

func mixedPodView(_ view: UIView) -> UIView {
  mixedQueue.sync {
    precondition(expo_umbrella_fixture_value() == 17)
    return view
  }
}
