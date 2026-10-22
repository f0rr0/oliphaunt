private let mixedQueue = DispatchQueue(label: "oliphaunt.expo.mixed")

func mixedPodView(_ view: UIView) -> UIView {
  mixedQueue.sync {
    precondition(expo_umbrella_fixture_value() == 17)
    return view
  }
}
