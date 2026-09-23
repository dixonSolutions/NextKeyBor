file(READ ${IN} XML)
file(WRITE ${OUT} "// Generated from io.github.nextkeybor.Daemon.xml\nextern const char nkb_iface_xml[];\nconst char nkb_iface_xml[] = R\"NKBXML(${XML})NKBXML\";\n")
