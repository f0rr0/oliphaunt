private let headerlessQueue = DispatchQueue(label: "oliphaunt.expo.headerless")

func headerlessPodView(_ view: UIView) -> UIView {
  headerlessQueue.sync { view }
}
