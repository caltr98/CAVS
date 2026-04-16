package main

// must panics on error; used for wiring in main() / small CLIs.
func must(err error) {
	if err != nil {
		panic(err)
	}
}
