<#import "template.ftl" as layout>
<#import "kin-home.ftl" as kin>
<#-- Keycloak 26.7.3 base error.ftl with one change: every error page has the way back into HALO PACS (kin-home.ftl).
     The base page drew a link only when the request named a client with a base URL; the product's login client has
     none, and an error with no known client (wrong address) has no client at all, so the page had no way out. The
     message itself is Keycloak's, unchanged. -->
<@layout.registrationLayout displayMessage=false; section>
    <#if section = "header">
        ${kcSanitize(msg("errorTitle"))?no_esc}
    <#elseif section = "form">
        <div id="kc-error-message">
            <p class="instruction">${kcSanitize(message.summary)?no_esc}</p>
            <#if traceId??>
                <p class="instruction" id="traceId">${msg("traceIdSupportMessage", traceId)}</p>
            </#if>
            <@kin.homeButton id="kin-back" label="backToKin"/>
        </div>
    </#if>
</@layout.registrationLayout>
