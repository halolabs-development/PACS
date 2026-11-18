<#-- The one way from a page the login server draws back into HALO PACS: the product's own login start. It is a plain
     same-origin path with nothing attached (no token, no user, no client value), so a person who lands on a dead end -
     a used or expired reset link, a lost login cookie, a wrong address - starts the login again from the product.
     info.ftl and error.ftl both draw it through this macro; the address lives only here. -->
<#macro homeButton id label>
    <div id="kc-form-buttons" class="${properties.kcFormButtonsClass!}">
        <a id="${id}" class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}" href="/api/auth/login">${msg(label)}</a>
    </div>
</#macro>
