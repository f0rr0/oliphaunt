private let mixedQueue = DispatchQueue(label: "oliphaunt.expo.mixed")

@objc public class ExpoUmbrellaSwiftValue: NSObject {
  @objc public static func value() -> Int32 { 17 }
}

func mixedPodView(_ view: UIView) -> UIView {
  mixedQueue.sync {
    precondition(expo_umbrella_fixture_value() == 17)
    return view
  }
}
